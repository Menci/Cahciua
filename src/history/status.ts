import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';

const { values } = parseArgs({ options: { history: { type: 'string' }, generation: { type: 'string' }, chat: { type: 'string' } } });
if (!values.history || !values.generation) throw new Error('Usage: pnpm exec tsx src/history/status.ts --history data/history.db --generation NAME [--chat CHAT_ID]');
const sqlite = new Database(values.history, { readonly: true, fileMustExist: true });
try {
  const state = sqlite.prepare('SELECT * FROM history_consumers WHERE generation = ?').get(values.generation);
  const coverage = values.chat
    ? sqlite.prepare('SELECT * FROM history_checkpoints WHERE generation = ? AND chat_id = ?').all(values.generation, values.chat)
    : sqlite.prepare('SELECT * FROM history_checkpoints WHERE generation = ? ORDER BY chat_id, source_kind LIMIT 256').all(values.generation);
  console.log(JSON.stringify({ state, coverage, coverageLimit: values.chat ? 3 : 256, observedAt: Date.now() }));
} finally { sqlite.close(); }
