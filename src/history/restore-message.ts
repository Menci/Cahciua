import type { Database as SqliteDatabase } from 'better-sqlite3';

import type { DB } from '../db/client';
import type { ArchiveKey, HistoryArchive } from '../db/history-archive';
import { createEmptyIC, reduce } from '../projection';
import type { ICMessage, PipelineEvent } from '../projection';
import type { WorkspaceBudget } from './budget';
import { eventCacheKeys } from './media-dependencies';
import { updateMessageSource } from './message-items';
import type { MessageSource } from './message-items';
import type { HistoryCommit } from './store';

// Only a target's canonical revisions and its reply-at-creation dependency are
// restored. Neither the whole chat nor the already built prefix is replayed.
// All reads share this bounded synchronous source transaction, released before
// history commit. The reducer copies only a direct parent's sender/content;
// that parent's own reply snapshot is not a dependency of the target.
export const restoreMessage = (deps: {
  db: DB;
  history: SqliteDatabase;
  generation: string;
  archive: HistoryArchive;
  chatId: string;
  messageId: string;
  maxSourceBytes: number;
  budget: WorkspaceBudget;
  hydrateAltText?: (event: PipelineEvent, reserve: (bytes: number) => void) => void;
}): { node: ICMessage; source: MessageSource; cacheKeys: readonly string[]; revisions: NonNullable<HistoryCommit['revisions']> } | undefined => deps.db.$client.transaction(() => {
  const cacheKeys = new Set<string>();
  const restore = (messageId: string, before?: ArchiveKey, withReplySnapshot = true): { node: ICMessage; source: MessageSource; revisions: NonNullable<HistoryCommit['revisions']> } | undefined => {
    deps.budget.entry();
    let ic = createEmptyIC(deps.chatId);
    let after: ArchiveKey = { timeMs: -Number.MAX_SAFE_INTEGER, id: 0 };
    let source: MessageSource | undefined;
    const revisions: NonNullable<HistoryCommit['revisions']>[number][] = [];
    for (;;) {
      const key = deps.history.prepare(`SELECT received_at AS timeMs, event_id AS id FROM history_event_targets
        WHERE generation = ? AND chat_id = ? AND message_id = ? AND (received_at, event_id) > (?, ?)
        AND (received_at, event_id) < (?, ?) ORDER BY received_at, event_id LIMIT 1`).get(
        deps.generation, deps.chatId, messageId, after.timeMs, after.id, before?.timeMs ?? Number.MAX_SAFE_INTEGER, before?.id ?? Number.MAX_SAFE_INTEGER,
      ) as ArchiveKey | undefined;
      if (!key) break;
      deps.budget.entry();
      const row = deps.archive.readEvents({ bounds: { chatId: deps.chatId, upperIds: { events: key.id, turn_responses_v2: 0, compactions: 0 } }, exactId: key.id, limit: 1, maxBytes: deps.maxSourceBytes }).rows[0];
      if (!row) throw new Error('Missing indexed archive event');
      deps.budget.reserve(row.encodedBytes ?? Buffer.byteLength(JSON.stringify(row)));
      for (const cacheKey of eventCacheKeys(row.event)) cacheKeys.add(cacheKey);
      deps.hydrateAltText?.(row.event, bytes => deps.budget.reserve(bytes));
      if (withReplySnapshot && row.event.type === 'message' && row.event.replyToMessageId && !ic.nodes.some(node => node.type === 'message' && node.messageId === messageId)) {
        const parent = restore(row.event.replyToMessageId, key, false);
        if (parent) ic = { ...ic, nodes: [parent.node] };
      }
      ic = reduce(ic, row.event);
      const parentRevision = source?.revision;
      source = updateMessageSource(source, row);
      if (source) revisions.push({ messageId, eventId: row.ref.id, source: row.ref, archiveRevision: row.revision, parentRevision, revision: source.revision });
      // Reply snapshots have now been taken. Drop temporary parent/system nodes.
      ic = { ...ic, nodes: ic.nodes.filter(node => node.type === 'message' && node.messageId === messageId), users: new Map() };
      after = key;
    }
    const node = ic.nodes.find((node): node is ICMessage => node.type === 'message');
    return node && source ? { node, source, revisions } : undefined;
  };
  const result = restore(deps.messageId);
  return result ? { ...result, cacheKeys: [...cacheKeys] } : undefined;
})();
