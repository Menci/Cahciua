import type { Database as SqliteDatabase } from 'better-sqlite3';

import type { ArchiveKey, ArchivePage, ArchivePageRequest, ArchiveValue, HistoryArchive, HistorySource } from '../db/history-archive';

// Source ordering/target indexes belong to history.db. Reads of archive content
// use its existing primary key, without installing any source index or trigger.
export const createIndexedHistoryArchive = (archive: HistoryArchive, history: SqliteDatabase, generation: string): HistoryArchive => {
  const locate = (source: HistorySource, request: ArchivePageRequest): ArchiveKey[] => {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new Error('History page limit must be a positive safe integer');
    const byId = source === 'compactions' && request.compactionsById;
    return history.prepare(`SELECT time_ms AS timeMs, source_id AS id FROM history_source_observations
      WHERE generation = ? AND source_kind = ? AND chat_id = ? AND source_id <= ?
      AND ${byId ? 'source_id > ?' : '(time_ms, source_id) > (?, ?)'}
      ORDER BY ${byId ? 'source_id' : 'time_ms, source_id'} LIMIT ?`).all(
      generation, source, request.bounds.chatId, request.bounds.upperIds[source],
      ...(byId ? [request.after?.id ?? 0] : [request.after?.timeMs ?? -Number.MAX_SAFE_INTEGER, request.after?.id ?? 0]), request.limit,
    ) as ArchiveKey[];
  };
  const page = <T extends ArchiveValue>(rows: T[], keys: ArchiveKey[], request: ArchivePageRequest): ArchivePage<T> => {
    if (request.maxBytes !== undefined && rows.reduce((sum, row) => sum + (row.encodedBytes ?? 0), 0) > request.maxBytes) throw new Error('History source exceeds encoded byte budget; cursor unchanged');
    for (const [i, row] of rows.entries()) if (row.key.timeMs !== keys[i]!.timeMs) throw new Error('Archive ordering key changed; rebuild the history generation');
    return { rows, next: keys.at(-1), done: keys.length < request.limit };
  };
  return {
    captureBounds: archive.captureBounds,
    readEvents(request) {
      if (request.exactId !== undefined) return archive.readEvents(request);
      const keys = locate('events', request);
      const rows = keys.map(key => {
        const row = archive.readEvents({ ...request, exactId: key.id, limit: 1 }).rows[0];
        if (!row) throw new Error('Missing indexed archive event');
        return row;
      });
      return page(rows, keys, request);
    },
    async readTurns(request) {
      if (request.exactId !== undefined) return await archive.readTurns(request);
      const keys = locate('turn_responses_v2', request);
      const rows = [];
      for (const key of keys) {
        const row = (await archive.readTurns({ ...request, exactId: key.id, limit: 1 })).rows[0];
        if (!row) throw new Error('Missing indexed archive turn');
        rows.push(row);
      }
      return page(rows, keys, request);
    },
    readCompactions(request) {
      if (request.exactId !== undefined) return archive.readCompactions(request);
      const keys = locate('compactions', request);
      const rows = keys.map(key => {
        const row = archive.readCompactions({ ...request, exactId: key.id, limit: 1 }).rows[0];
        if (!row) throw new Error('Missing indexed archive compaction');
        return row;
      });
      return page(rows, keys, request);
    },
  };
};
