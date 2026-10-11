import type { Database as SqliteDatabase } from 'better-sqlite3';

import type { ArchiveKey } from '../db/history-archive';

export interface MessageRevisionRange {
  readonly messageId: string;
  readonly origin: ArchiveKey;
  readonly until: ArchiveKey;
  readonly after?: ArchiveKey;
  readonly parentRevision?: string;
}
export interface MessageRevisionLocator extends ArchiveKey {
  readonly archiveRevision: string;
}

// Fingerprints are streamed from History's private index. Old event bodies and
// a resident array of the complete revision chain are never needed here.
export const messageRevisionLocators = function* (history: SqliteDatabase, generation: string, chatId: string, range: MessageRevisionRange): IterableIterator<MessageRevisionLocator> {
  // End each query before yielding: better-sqlite3 disallows writes on a
  // connection with an active iterate(), including our atomic revision commit.
  const statement = history.prepare(`SELECT t.received_at AS timeMs, t.event_id AS id, o.revision AS archiveRevision
    FROM history_event_targets t JOIN history_source_observations o
      ON o.generation = t.generation AND o.source_kind = 'events' AND o.source_key = CAST(t.event_id AS TEXT)
    WHERE t.generation = ? AND t.chat_id = ? AND t.message_id = ?
      AND (t.received_at, t.event_id) >= (?, ?) AND (t.received_at, t.event_id) <= (?, ?)
      AND (t.received_at, t.event_id) > (?, ?) ORDER BY t.received_at, t.event_id LIMIT 1`);
  let after = range.after ?? { timeMs: -Number.MAX_SAFE_INTEGER, id: 0 };
  for (;;) {
    const row = statement.get(generation, chatId, range.messageId, range.origin.timeMs, range.origin.id, range.until.timeMs, range.until.id, after.timeMs, after.id) as MessageRevisionLocator | undefined;
    if (!row) return;
    yield row;
    after = row;
  }
};
