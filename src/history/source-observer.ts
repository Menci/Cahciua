import type { Database as SqliteDatabase } from 'better-sqlite3';

import { createHistoryInbox } from './inbox';
import { eventCacheKeys, needsAnimationHash } from './media-dependencies';
import type { DB } from '../db/client';
import { archiveRevision } from '../db/history-archive';
import type { ArchivedCompaction, ArchivedEvent, ArchivedTurn, HistoryArchive, HistorySource } from '../db/history-archive';

type SourceKind = HistorySource | 'image_alt_texts';
const sourceKinds: readonly HistorySource[] = ['events', 'turn_responses_v2', 'compactions'];
export interface SourceObservation {
  readonly sourceKind: SourceKind;
  readonly sourceKey: string;
  readonly chatId: string | null;
  readonly revision: string;
  readonly timeMs: number;
  readonly targetIds: readonly string[];
  readonly taskIds: readonly number[];
  readonly messageId: string | null;
  readonly replyToMessageId: string | null;
}
export interface HistorySourceChange {
  readonly seq: number;
  readonly sourceKind: SourceKind;
  readonly sourceKey: string;
  readonly chatId: string | null;
  readonly targetIds: readonly string[];
  readonly taskIds: readonly number[];
}
interface ScanState {
  sourceIndex: number;
  afterIds: Record<HistorySource, number>;
  upperIds: Record<HistorySource, number>;
  completedPolls: number;
  completedAtMs: number | null;
}

export const describeSource = (row: ArchivedEvent | ArchivedTurn | ArchivedCompaction): SourceObservation => {
  const event = 'event' in row ? row.event : undefined;
  return {
    sourceKind: row.ref.source, sourceKey: String(row.ref.id), chatId: row.ref.chatId,
    revision: row.revision, timeMs: row.key.timeMs,
    targetIds: event?.type === 'delete' ? event.messageIds : event && 'messageId' in event ? [event.messageId] : [],
    taskIds: event?.type === 'runtime' ? [event.taskId] : [],
    messageId: event && 'messageId' in event ? event.messageId : null,
    replyToMessageId: event?.type === 'message' ? event.replyToMessageId ?? null : null,
  };
};

// This function participates in the caller's history.db transaction. It never
// writes the source connection, and keeps only fingerprints and locators.
export const writeSourceObservation = (sqlite: SqliteDatabase, generation: string, observation: SourceObservation, emit: boolean): void => {
  const previousRow = sqlite.prepare('SELECT observation_json AS value FROM history_source_observations WHERE generation = ? AND source_kind = ? AND source_key = ?').get(generation, observation.sourceKind, observation.sourceKey) as { value: string } | undefined;
  const previous = previousRow ? JSON.parse(previousRow.value) as SourceObservation : undefined;
  if (previous && (previous.chatId !== observation.chatId || previous.timeMs !== observation.timeMs)) throw new Error('Archive source changed chat/order identity; rebuild this history generation');
  if (previous?.revision === observation.revision) return;
  if (emit) {
    const change: Omit<HistorySourceChange, 'seq'> = {
      sourceKind: observation.sourceKind, sourceKey: observation.sourceKey, chatId: observation.chatId,
      targetIds: [...new Set([...(previous?.targetIds ?? []), ...observation.targetIds])],
      taskIds: [...new Set([...(previous?.taskIds ?? []), ...observation.taskIds])],
    };
    sqlite.prepare('INSERT INTO history_source_changes(generation, change_json) VALUES (?, ?)').run(generation, JSON.stringify(change));
  }
  sqlite.prepare(`INSERT INTO history_source_observations(generation, source_kind, source_key, source_id, chat_id, revision, observation_json, message_id, reply_to_message_id, task_id, time_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(generation, source_kind, source_key) DO UPDATE SET revision=excluded.revision, observation_json=excluded.observation_json, message_id=excluded.message_id, reply_to_message_id=excluded.reply_to_message_id, task_id=excluded.task_id, time_ms=excluded.time_ms`).run(
    generation, observation.sourceKind, observation.sourceKey, observation.sourceKind === 'image_alt_texts' ? null : Number(observation.sourceKey), observation.chatId, observation.revision, JSON.stringify(observation),
    observation.messageId, observation.replyToMessageId, observation.taskIds[0] ?? null, observation.timeMs,
  );
  if (observation.sourceKind === 'events') {
    sqlite.prepare('DELETE FROM history_event_targets WHERE generation = ? AND event_id = ?').run(generation, Number(observation.sourceKey));
    const insert = sqlite.prepare('INSERT INTO history_event_targets(generation, chat_id, message_id, event_id, received_at) VALUES (?, ?, ?, ?, ?)');
    for (const id of new Set(observation.targetIds)) insert.run(generation, observation.chatId, id, Number(observation.sourceKey), observation.timeMs);
  }
};

export const createHistoryChanges = (sqlite: SqliteDatabase, generation: string) => ({
  watermark: (): number => (sqlite.prepare('SELECT coalesce(max(seq), 0) AS seq FROM history_source_changes WHERE generation = ?').get(generation) as { seq: number }).seq,
  lag: (after: number): number => (sqlite.prepare('SELECT count(*) AS count FROM history_source_changes WHERE generation = ? AND seq > ?').get(generation, after) as { count: number }).count,
  next(after: number, maxBytes: number): HistorySourceChange | undefined {
    const size = sqlite.prepare('SELECT octet_length(change_json) + 1024 AS bytes FROM history_source_changes WHERE generation = ? AND seq > ? ORDER BY seq LIMIT 1').get(generation, after) as { bytes: number } | undefined;
    if (size && size.bytes > maxBytes) throw new Error('History observation exceeds encoded byte budget; cursor unchanged');
    const row = sqlite.prepare('SELECT seq, change_json AS value FROM history_source_changes WHERE generation = ? AND seq > ? ORDER BY seq LIMIT 1').get(generation, after) as { seq: number; value: string } | undefined;
    return row ? { ...JSON.parse(row.value) as Omit<HistorySourceChange, 'seq'>, seq: row.seq } : undefined;
  },
});

export const createSourceObserver = (deps: {
  db: DB;
  archive: HistoryArchive;
  sqlite: SqliteDatabase;
  generation: string;
  maxSourceBytes: number;
  maxStateEntries: number;
}) => {
  const { db, archive, sqlite, generation } = deps;
  const inbox = createHistoryInbox(sqlite, generation);
  const changes = createHistoryChanges(sqlite, generation);
  const load = (): ScanState | undefined => {
    const row = sqlite.prepare('SELECT state_json AS value FROM history_source_scans WHERE generation = ?').get(generation) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as ScanState : undefined;
  };
  const save = (state: ScanState) => sqlite.prepare('INSERT INTO history_source_scans(generation, state_json) VALUES (?, ?) ON CONFLICT(generation) DO UPDATE SET state_json=excluded.state_json').run(generation, JSON.stringify(state));
  const capture = (previous?: ScanState): ScanState => {
    const upperIds = db.$client.transaction(() => Object.fromEntries(sourceKinds.map(kind => {
      const row = db.$client.prepare(`SELECT coalesce(max(id), 0) AS value FROM ${kind}`).get() as { value: number };
      return [kind, row.value];
    })))() as ScanState['upperIds'];
    if (previous && sourceKinds.some(kind => upperIds[kind] < previous.afterIds[kind])) throw new Error('Archive source ID fence regressed; rebuild the history generation');
    return { sourceIndex: 0, afterIds: previous?.afterIds ?? { events: 0, turn_responses_v2: 0, compactions: 0 }, upperIds, completedPolls: previous?.completedPolls ?? 0, completedAtMs: previous?.completedAtMs ?? null };
  };
  const read = async (kind: HistorySource, id: number, chatId: string) => {
    const request = { bounds: { chatId, upperIds: { events: id, turn_responses_v2: id, compactions: id } }, exactId: id, limit: 1, maxBytes: deps.maxSourceBytes };
    const row = kind === 'events' ? archive.readEvents(request).rows[0] : kind === 'turn_responses_v2' ? (await archive.readTurns(request)).rows[0] : archive.readCompactions(request).rows[0];
    if (!row) throw new Error('Missing archive observation row; cursor unchanged');
    return row;
  };
  const registerPending = (row: ArchivedEvent) => {
    const keys = eventCacheKeys(row.event);
    if (keys.length > deps.maxStateEntries) throw new Error('History media dependencies exceed dependency budget; cursor unchanged');
    const insert = sqlite.prepare(`INSERT INTO history_pending_media(generation, source_kind, source_key, chat_id)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`);
    const register = (sourceKind: 'events' | 'image_alt_texts', sourceKey: string, chatId: string | null) => {
      if (insert.get(generation, sourceKind, sourceKey, chatId)) {
        // A durable, one-time reread covers completion between the initial
        // source read and dependency registration, even if its notice ran first.
        inbox.receive({ kind: 'media', sourceKind, sourceKey });
      }
    };
    if (needsAnimationHash(row.event)) register('events', String(row.ref.id), row.ref.chatId);
    for (const key of keys) {
      if (!db.$client.prepare('SELECT 1 FROM image_alt_texts WHERE image_hash = ?').get(key)) register('image_alt_texts', key, null);
    }
  };
  type MediaTarget = { id?: number; kind: 'events' | 'image_alt_texts'; key: string; chatId: string | null };
  const inspectMediaTarget = (target: MediaTarget) => {
    let complete = false;
    let observation: SourceObservation | undefined;
    let event: ArchivedEvent | undefined;
    if (target.kind === 'events') {
      const id = Number(target.key);
      event = archive.readEvents({ bounds: { chatId: target.chatId!, upperIds: { events: id, turn_responses_v2: 0, compactions: 0 } }, exactId: id, limit: 1, maxBytes: deps.maxSourceBytes }).rows[0];
      if (!event) throw new Error('Missing pending event source; input retained');
      observation = describeSource(event);
      complete = !needsAnimationHash(event.event);
    } else {
      const row = db.$client.transaction(() => {
        const size = db.$client.prepare('SELECT octet_length(alt_text) + coalesce(octet_length(sticker_set_name), 0) + 1024 AS bytes FROM image_alt_texts WHERE image_hash = ?').get(target.key) as { bytes: number } | undefined;
        if (size && size.bytes > deps.maxSourceBytes) throw new Error('History cache observation exceeds source byte budget; input retained');
        return size ? db.$client.prepare('SELECT * FROM image_alt_texts WHERE image_hash = ?').get(target.key) : undefined;
      })();
      if (row) {
        complete = true;
        observation = { sourceKind: target.kind, sourceKey: target.key, revision: archiveRevision(row), chatId: null, timeMs: 0, targetIds: [], taskIds: [], messageId: null, replyToMessageId: null };
      }
    }
    return () => {
      if (observation) writeSourceObservation(sqlite, generation, observation, true);
      if (event) registerPending(event);
      // Keep completion responsibility until its observation's materialization
      // commits. Queue failure rolls back this scheduled marker as well.
      if (complete && target.id !== undefined) sqlite.prepare('UPDATE history_pending_media SET scheduled_seq = ? WHERE id = ?').run(changes.watermark(), target.id);
    };
  };
  const consumeInput = (): boolean => {
    const input = sqlite.prepare(`SELECT id, source_kind AS kind, source_key AS key, after_id AS afterId, upper_id AS upperId, after_key AS afterKey, upper_key AS upperKey
      FROM history_build_inputs WHERE generation = ? ORDER BY id LIMIT 1`).get(generation) as { id: number; kind: 'events' | 'image_alt_texts' | 'pending' | 'dependencies'; key: string; afterId: number; upperId: number | null; afterKey: string | null; upperKey: string | null } | undefined;
    if (!input) return false;
    const upper = input.kind === 'pending' ? input.upperId ?? (sqlite.prepare('SELECT coalesce(max(id), 0) AS id FROM history_pending_media WHERE generation = ?').get(generation) as { id: number }).id : 0;
    const upperKey = input.kind === 'dependencies' ? input.upperKey ?? (sqlite.prepare('SELECT max(cache_key) AS key FROM history_media_dependencies WHERE generation = ?').get(generation) as { key: string | null }).key : null;
    const dependency = input.kind === 'dependencies' && upperKey !== null
      ? sqlite.prepare('SELECT cache_key AS key FROM history_media_dependencies WHERE generation = ? AND cache_key > ? AND cache_key <= ? ORDER BY cache_key LIMIT 1').get(generation, input.afterKey ?? '', upperKey) as { key: string } | undefined
      : undefined;
    const target = input.kind === 'pending'
      ? sqlite.prepare(`SELECT id, source_kind AS kind, source_key AS key, chat_id AS chatId FROM history_pending_media
        WHERE generation = ? AND scheduled_seq IS NULL AND id > ? AND id <= ? ORDER BY id LIMIT 1`).get(generation, input.afterId, upper) as MediaTarget | undefined
      : sqlite.prepare(`SELECT id, source_kind AS kind, source_key AS key, chat_id AS chatId FROM history_pending_media
        WHERE generation = ? AND source_kind = ? AND source_key = ? AND scheduled_seq IS NULL`).get(generation, input.kind, input.key) as MediaTarget | undefined;
    // A direct cache notification also observes already-complete keys. Pending
    // tracks missing dependencies, not whether a cache change is relevant.
    const notification: MediaTarget | undefined = dependency ? { kind: 'image_alt_texts', key: dependency.key, chatId: null }
      : target ?? (input.kind === 'image_alt_texts' ? { kind: input.kind, key: input.key, chatId: null } : undefined);
    const commit = notification ? inspectMediaTarget(notification) : undefined;
    sqlite.transaction(() => {
      commit?.();
      if (dependency) sqlite.prepare('UPDATE history_build_inputs SET after_key = ?, upper_key = ? WHERE id = ?').run(dependency.key, upperKey, input.id);
      else if (input.kind === 'pending' && target) sqlite.prepare('UPDATE history_build_inputs SET after_id = ?, upper_id = ? WHERE id = ?').run(target.id, upper, input.id);
      else sqlite.prepare('DELETE FROM history_build_inputs WHERE id = ?').run(input.id);
    })();
    return true;
  };
  let schedulingStep = 0;
  return {
    status: () => {
      const state = load();
      const pending = sqlite.prepare('SELECT count(*) AS count FROM history_pending_media WHERE generation = ?').get(generation) as { count: number };
      return {
        completedSourcePolls: state?.completedPolls ?? 0, lastSourcePollAtMs: state?.completedAtMs ?? null, sourceHighwaterIds: state?.afterIds ?? null, pollingSource: state && state.sourceIndex < sourceKinds.length ? sourceKinds[state.sourceIndex] : null, pendingMedia: pending.count,
        buildInputBacklog: inbox.count(), mediaRecoveryActive: !!sqlite.prepare("SELECT 1 FROM history_build_inputs WHERE generation = ? AND source_kind IN ('pending', 'dependencies')").get(generation),
      };
    },
    async step(discover = true): Promise<{ processedRows: number }> {
      // Receipt is cheap and durable; expensive inspection is scheduled here,
      // with finite recovery cursors and no normal media polling.
      if ((!discover || ++schedulingStep % 4 === 0) && consumeInput()) return { processedRows: 1 };
      if (!discover) return { processedRows: 0 };
      let state = load();
      if (!state || state.sourceIndex === sourceKinds.length) { state = capture(state); sqlite.transaction(() => save(state!))(); }
      const sourceKind = sourceKinds[state.sourceIndex]!;
      const after = state.afterIds[sourceKind];
      const upper = state.upperIds[sourceKind];
      const locator = db.$client.prepare(`SELECT id, chat_id AS chatId FROM ${sourceKind} WHERE id > ? AND id <= ? ORDER BY id LIMIT 1`).get(after, upper) as { id: number; chatId: string } | undefined;
      if (!locator) {
        state = { ...state, sourceIndex: state.sourceIndex + 1, afterIds: { ...state.afterIds, [sourceKind]: upper } };
        if (state.sourceIndex === sourceKinds.length) state = { ...state, completedPolls: state.completedPolls + 1, completedAtMs: Date.now() };
        sqlite.transaction(() => save(state!))();
        return { processedRows: 0 };
      }
      const row = await read(sourceKind, locator.id, locator.chatId);
      const observation = describeSource(row);
      const next = { ...state, afterIds: { ...state.afterIds, [sourceKind]: locator.id } };
      const checkpoint = sqlite.prepare('SELECT upper_id AS value FROM history_checkpoints WHERE generation = ? AND chat_id = ? AND source_kind = ?').get(generation, observation.chatId, sourceKind) as { value: number } | undefined;
      const coveredByBootstrap = state.completedPolls === 0 && checkpoint && locator.id <= checkpoint.value;
      sqlite.transaction(() => {
        writeSourceObservation(sqlite, generation, observation, !coveredByBootstrap);
        if ('event' in row) registerPending(row);
        save(next);
      })();
      return { processedRows: 1 };
    },
  };
};
