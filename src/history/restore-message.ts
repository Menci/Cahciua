import type { DB } from '../db/client';
import type { ArchiveKey, ArchivedEvent, HistoryArchive } from '../db/history-archive';
import { createEmptyIC, reduce } from '../projection';
import type { ICMessage, IntermediateContext, PipelineEvent } from '../projection';
import type { WorkspaceBudget } from './budget';
import { eventCacheKeys } from './media-dependencies';
import { messageRevision } from './message-items';
import type { MessageSource } from './message-items';
import { messageRevisionLocators } from './message-revisions';
import type { MessageRevisionRange } from './message-revisions';
import type { HistoryStore } from './store';

// Ordinary append edits reuse the materialized node. Historical reconstruction
// selects only effective overwrite events; intermediate edit bodies are never
// decoded. Reply snapshots use the parent's state strictly before creation.
export const restoreMessage = (deps: {
  db: DB;
  store: HistoryStore;
  generation: string;
  archive: HistoryArchive;
  chatId: string;
  messageId: string;
  maxSourceBytes: number;
  budget: WorkspaceBudget;
  refreshReplySnapshot?: boolean;
  refreshMedia?: boolean;
  hydrateAltText?: (event: PipelineEvent, reserve: (bytes: number) => void) => void;
}): { node: ICMessage; source: MessageSource; cacheKeys: readonly string[]; revisionRange: MessageRevisionRange } | undefined => deps.db.$client.transaction(() => {
  const { store, generation, chatId, budget } = deps;
  const history = store.sqlite;
  const keyFor = (messageId: string, id: number): ArchiveKey | undefined => history.prepare('SELECT received_at AS timeMs, event_id AS id FROM history_event_targets WHERE generation=? AND chat_id=? AND message_id=? AND event_id=?').get(generation, chatId, messageId, id) as ArchiveKey | undefined;
  const earlier = (a: ArchiveKey, b: ArchiveKey) => a.timeMs < b.timeMs || (a.timeMs === b.timeMs && a.id < b.id);
  const read = (key: ArchiveKey): ArchivedEvent => {
    budget.entry();
    const row = deps.archive.readEvents({ bounds: { chatId, upperIds: { events: key.id, turn_responses_v2: 0, compactions: 0 } }, exactId: key.id, limit: 1, maxBytes: deps.maxSourceBytes }).rows[0];
    if (!row) throw new Error('Missing indexed archive event');
    budget.reserve(row.encodedBytes ?? Buffer.byteLength(JSON.stringify(row)));
    return row;
  };
  const restore = (messageId: string, before: ArchiveKey = { timeMs: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER }, withReplySnapshot = true): { node: ICMessage; source: MessageSource; revisionRange: MessageRevisionRange } | undefined => {
    const persisted = store.loadMessage(generation, chatId, messageId, budget);
    const originKey = persisted && keyFor(messageId, persisted.source.origin.id);
    const savedKey = persisted && keyFor(messageId, persisted.source.changedBy.id);
    // A backdated insertion or a changed media source invalidates the prefix.
    // This checks locators/fingerprints in SQLite, without loading old bodies.
    const prefixChanged = savedKey && history.prepare(`SELECT 1 FROM history_event_targets t
      JOIN history_source_observations o ON o.generation=t.generation AND o.source_kind='events' AND o.source_key=CAST(t.event_id AS TEXT)
      LEFT JOIN history_message_revisions r ON r.generation=t.generation AND r.chat_id=t.chat_id AND r.message_id=t.message_id AND r.event_id=t.event_id
      WHERE t.generation=? AND t.chat_id=? AND t.message_id=? AND (t.received_at,t.event_id)<=(?,?)
        AND (r.event_id IS NULL OR r.archive_revision<>o.revision) LIMIT 1`).get(generation, chatId, messageId, savedKey.timeMs, savedKey.id);
    // Saved nodes contain derived media fields. A cache change restores the
    // effective raw sources, preserving authoritative fields while reselecting
    // descriptions with the same precedence as a fresh build.
    const cached = !deps.refreshMedia && persisted && originKey && savedKey && earlier(savedKey, before) && !prefixChanged ? persisted : undefined;
    let ic: IntermediateContext = { ...createEmptyIC(chatId), nodes: cached ? [cached.node] : [] };
    let source = cached?.source;
    let origin = cached ? originKey : undefined;
    let selfSent = cached?.node.isSelfSent ?? false;
    const selected = new Map<number, ArchiveKey>();
    let lastEdit: ArchiveKey | undefined;
    let lastEcho: ArchiveKey | undefined;
    let lastDelete: ArchiveKey | undefined;
    let firstSelf: ArchiveKey | undefined;
    let until = cached ? savedKey : undefined;
    const upper: ArchiveKey = { timeMs: before.timeMs, id: before.id - 1 };
    // Time/ID upper fence is inclusive; before itself must remain excluded.
    const range = { messageId, origin: { timeMs: -Number.MAX_SAFE_INTEGER, id: 0 }, until: upper, after: cached ? savedKey : undefined };
    const typeFor = deps.db.$client.prepare('SELECT type,is_self_sent AS isSelfSent FROM events WHERE id=? AND chat_id=?');
    for (const key of messageRevisionLocators(history, generation, chatId, range)) {
      const metadata = typeFor.get(key.id, chatId) as { type: string; isSelfSent: number | null } | undefined;
      if (!metadata) throw new Error('Missing indexed archive event');
      if (!source) {
        if (metadata.type !== 'message') continue;
        origin = key;
        selected.set(key.id, key);
        source = { origin: { source: 'events', chatId, id: key.id }, changedBy: { source: 'events', chatId, id: key.id }, revision: messageRevision(undefined, key.archiveRevision) };
        selfSent = !!metadata.isSelfSent;
      } else {
        source = { ...source, changedBy: { source: 'events', chatId, id: key.id }, revision: messageRevision(source.revision, key.archiveRevision) };
        if (metadata.type === 'message') {
          if (metadata.isSelfSent && !selfSent) { firstSelf = key; selfSent = true; }
          if (selfSent && !metadata.isSelfSent) lastEcho = key;
        } else if (metadata.type === 'edit') lastEdit = key;
        else if (metadata.type === 'delete') lastDelete = key;
      }
      until = key;
    }
    if (!source || !origin || !until) return undefined;
    for (const key of [firstSelf, lastEcho, lastEdit, lastDelete]) if (key) selected.set(key.id, key);
    if (cached && withReplySnapshot && deps.refreshReplySnapshot !== false && cached.node.replyToMessageId) {
      const originRow = read(origin);
      if (originRow.event.type !== 'message') throw new Error('Historical origin is not a message');
      const parent = originRow.event.replyToMessageId ? restore(originRow.event.replyToMessageId, origin, false) : undefined;
      const snapshot = reduce({ ...createEmptyIC(chatId), nodes: parent ? [parent.node] : [] }, originRow.event).nodes.find((node): node is ICMessage => node.type === 'message' && node.messageId === messageId)!;
      ic = { ...ic, nodes: [{ ...cached.node, replyToSender: snapshot.replyToSender, replyToPreview: snapshot.replyToPreview, replyToContent: snapshot.replyToContent, replyQuoteContent: snapshot.replyQuoteContent }] };
    }
    for (const key of [...selected.values()].sort((a, b) => a.timeMs - b.timeMs || a.id - b.id)) {
      const row = read(key);
      if (withReplySnapshot && row.event.type === 'message' && !ic.nodes.some(node => node.type === 'message' && node.messageId === messageId) && row.event.replyToMessageId) {
        const parent = restore(row.event.replyToMessageId, key, false);
        if (parent) ic = { ...ic, nodes: [parent.node] };
      }
      ic = reduce(ic, row.event);
      ic = { ...ic, nodes: ic.nodes.filter(node => node.type === 'message' && node.messageId === messageId), users: new Map() };
    }
    const node = ic.nodes.find((node): node is ICMessage => node.type === 'message');
    return node ? { node, source, revisionRange: { messageId, origin, until, after: cached ? savedKey : undefined, parentRevision: cached?.source.revision } } : undefined;
  };
  const result = restore(deps.messageId);
  if (!result) return undefined;
  // Reducer output is frozen; cache hydration owns a mutable JSON-safe copy.
  const node = structuredClone(result.node);
  budget.reserve(Buffer.byteLength(JSON.stringify(node)));
  const event: Extract<PipelineEvent, { type: 'edit' }> = { type: 'edit', chatId, messageId: node.messageId, receivedAtMs: node.receivedAtMs, timestampSec: node.timestampSec, utcOffsetMin: node.utcOffsetMin, content: node.content, attachments: node.attachments };
  deps.hydrateAltText?.(event, bytes => budget.reserve(bytes));
  const cacheKeys = new Set(eventCacheKeys(event));
  if (node.replyToContent) {
    const reply = { ...event, content: node.replyToContent, attachments: [] };
    deps.hydrateAltText?.(reply, bytes => budget.reserve(bytes));
    for (const key of eventCacheKeys(reply)) cacheKeys.add(key);
  }
  return { ...result, node, cacheKeys: [...cacheKeys] };
})();
