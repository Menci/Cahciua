import type { Database as SqliteDatabase } from 'better-sqlite3';

import type { HistoryNotification } from './notifications';

export const createHistoryInbox = (sqlite: SqliteDatabase, generation: string) => ({
  receive(input: HistoryNotification): void {
    sqlite.transaction(() => {
      const kinds = input.kind === 'recover' ? ['pending', 'dependencies'] : [input.sourceKind];
      const insert = sqlite.prepare(`INSERT INTO history_build_inputs(generation, source_kind, source_key)
        VALUES (?, ?, ?) ON CONFLICT(generation, source_kind, source_key) DO UPDATE SET
        after_id = CASE WHEN excluded.source_kind = 'pending' THEN 0 ELSE after_id END,
        upper_id = CASE WHEN excluded.source_kind = 'pending' THEN NULL ELSE upper_id END,
        after_key = CASE WHEN excluded.source_kind = 'dependencies' THEN NULL ELSE after_key END,
        upper_key = CASE WHEN excluded.source_kind = 'dependencies' THEN NULL ELSE upper_key END`);
      for (const kind of kinds) insert.run(generation, kind, input.kind === 'recover' ? '' : input.sourceKey);
    })();
  },
  count: (): number => (sqlite.prepare('SELECT count(*) AS count FROM history_build_inputs WHERE generation = ?').get(generation) as { count: number }).count,
});
