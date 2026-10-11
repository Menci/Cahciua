// Isolated Docker acceptance. Source is opened read-only; only its online backup
// is used for controlled fixture writes; history never migrates the source. Evidence contains counts/status, never message bodies.
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { createHistoryArchive } from '../../src/db/history-archive.ts';
import { loadImageAltTextByHash } from '../../src/db/persistence.ts';
import * as schema from '../../src/db/schema.ts';
import { buildHistoryInput } from '../../src/history/build-input.ts';
import { defaultHistoryLimits } from '../../src/history/budget.ts';
import { createCachedAltTextHydrator } from '../../src/media/alt-text-cache.ts';

const { values } = parseArgs({ options: { archive: { type: 'string' }, out: { type: 'string' } } });
if (!values.archive || !values.out) throw new Error('Expected --archive READONLY_SOURCE --out NEW_DIRECTORY');
const directory = resolve(values.out);
if (existsSync(directory)) throw new Error('Acceptance output directory must be new');
mkdirSync(directory, { recursive: true });
const sourceSchema = database => ({
  schema: database.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all(),
  migrations: database.prepare('SELECT * FROM __drizzle_migrations').all(),
});
const sourceRows = database => Object.fromEntries(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const production = new Database(values.archive, { readonly: true, fileMustExist: true });
const before = sourceSchema(production);
const began = performance.now();
await production.backup(`${directory}/archive.db`);
const backupMs = performance.now() - began;
production.close();
const sqlite = new Database(`${directory}/archive.db`);
sqlite.pragma('journal_mode = WAL');
const db = drizzle(sqlite, { schema });
if (sha(sourceSchema(sqlite)) !== sha(before)) throw new Error('Source backup schema differs');
const counts = Object.fromEntries(['events', 'turn_responses_v2', 'compactions'].map(table => [table, sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
const sourceSizes = {
  largestEncodedTurnBytes: sqlite.prepare('SELECT max(octet_length(entries)) AS n FROM turn_responses_v2').get().n,
  largestEventBodyBytes: sqlite.prepare('SELECT max(coalesce(octet_length(content),0) + coalesce(octet_length(attachments),0)) AS n FROM events').get().n,
};
const options = {
  archivePath: `${directory}/archive.db`, historyPath: `${directory}/history.db`, generation: 'real-online',
};
const children = [];
let errorTail = '';
let reader;
const start = entry => {
  const child = fork(resolve(entry), ['--history-worker', JSON.stringify(options)], {
    execArgv: entry.endsWith('.ts') ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.stderr.on('data', bytes => { errorTail = `${errorTail}${bytes}`.slice(-10000); });
  children.push(child);
  return child;
};
const waitFor = async read => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Acceptance deadline exceeded: ${errorTail}`);
};
const stop = async (child, signal) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolveExit => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('exit', () => { clearTimeout(timer); resolveExit(); });
    child.kill(signal);
  });
};
try {
  const first = start('src/history/worker.ts');
  await waitFor(() => {
    if (!existsSync(options.historyPath)) return;
    reader ??= new Database(options.historyPath, { readonly: true });
    if (!reader.prepare("SELECT name FROM sqlite_master WHERE name='history_checkpoints'").get()) return;
    return reader.prepare("SELECT after_json FROM history_checkpoints WHERE source_kind='events' AND after_json IS NOT NULL LIMIT 1").get();
  });
  const interrupted = reader.prepare('SELECT * FROM history_checkpoints ORDER BY chat_id,source_kind').all();
  await stop(first, 'SIGKILL');
  const chat = sqlite.prepare('SELECT chat_id FROM events GROUP BY chat_id ORDER BY count(*) DESC LIMIT 1').get().chat_id;
  // A backdated message and searchable summary are committed while offline.
  db.insert(schema.events).values({ chatId: chat, type: 'message', messageId: 'online-acceptance-backdated', receivedAtMs: 1, timestampSec: 1, utcOffsetMin: 480, content: [{ type: 'text', text: 'online isolation marker' }] }).run();
  db.insert(schema.compactions).values({ chatId: chat, oldCursorMs: 0, newCursorMs: 2, createdAt: 1, summary: 'online_real_summary_fixture' }).run();
  const workerRowsBefore = sha(sourceRows(sqlite));
  // Resume through the built distribution entry, with no tsx loader.
  const second = start('dist/history-worker.mjs');
  await waitFor(() => {
    const state = reader.prepare('SELECT baseline_complete,consume_seq,status_json FROM history_consumers').get();
    const status = state?.status_json ? JSON.parse(state.status_json) : undefined;
    return state?.baseline_complete && status?.completedSourcePolls >= 3 && status.logLag === 0;
  });
  await stop(second, 'SIGTERM');
  const archive = createHistoryArchive(db);
  const hydrateAltText = createCachedAltTextHydrator({ enabled: () => true, lookup: hash => loadImageAltTextByHash(db, hash) });
  const chats = sqlite.prepare('SELECT chat_id FROM events UNION SELECT chat_id FROM turn_responses_v2 UNION SELECT chat_id FROM compactions').all().map(row => row.chat_id);
  let expectedItems = 0;
  let mismatches = 0;
  // This deliberately unbounded reference is only an acceptance oracle.
  for (const chatId of chats) {
    const expected = new Map();
    for await (const batch of buildHistoryInput({ archive, bounds: archive.captureBounds(chatId), pageSize: 8, hydrateAltText })) {
      for (const change of batch.changes) expected.set(change.item.key, change.item);
    }
    const actual = reader.prepare('SELECT item_key,item_json FROM history_items WHERE chat_id=?').all(chatId);
    expectedItems += expected.size;
    if (actual.length !== expected.size) mismatches++;
    for (const row of actual) if (JSON.stringify(expected.get(row.item_key)) !== JSON.stringify(JSON.parse(row.item_json))) mismatches++;
  }
  const consumer = reader.prepare('SELECT * FROM history_consumers').get();
  const anonymize = rows => rows.map(row => ({ ...row, chat_id: `chat-${chats.indexOf(row.chat_id) + 1}` }));
  const coverage = anonymize(reader.prepare('SELECT * FROM history_checkpoints ORDER BY chat_id,source_kind').all());
  const kinds = reader.prepare('SELECT kind,count(*) AS n FROM history_items GROUP BY kind').all();
  const relations = reader.prepare('SELECT kind,count(*) AS n FROM history_relations GROUP BY kind').all();
  const integrity = reader.pragma('integrity_check', { simple: true });
  await reader.backup(`${directory}/finished.db`);
  const finished = new Database(`${directory}/finished.db`);
  finished.prepare("INSERT INTO history_fts(history_fts,rank) VALUES('integrity-check',1)").run();
  const summaryFts = finished.prepare("SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH 'online_real_summary_fixture'").get().n;
  finished.close();
  const productionAfter = new Database(values.archive, { readonly: true });
  const after = sourceSchema(productionAfter);
  productionAfter.close();
  const evidence = {
    backupMs, counts, sourceSizes, defaultHistoryLimits, usedDefaultLimits: true, chats: chats.length, interrupted: anonymize(interrupted), consumer, coverage, kinds, relations,
    expectedItems, mismatches, integrity, ftsIntegrity: 'passed', summaryFts,
    originalSchemaHashBefore: sha(before), originalSchemaHashAfter: sha(after), workerSourceSchemaHash: sha(sourceSchema(sqlite)), workerSourceRowsHashBefore: workerRowsBefore, workerSourceRowsHashAfter: sha(sourceRows(sqlite)), builtWorkerVerified: true, errorTail,
  };
  writeFileSync(`${directory}/real-online.json`, JSON.stringify(evidence, null, 2));
  if (mismatches || integrity !== 'ok' || summaryFts !== 1 || sha(before) !== sha(after) || sha(before) !== sha(sourceSchema(sqlite)) || workerRowsBefore !== sha(sourceRows(sqlite)) || errorTail) throw new Error('Real online verification failed');
  console.log(JSON.stringify({ counts, chats: chats.length, expectedItems, mismatches, integrity, summaryFts, backupMs, builtWorkerVerified: true }));
} finally {
  for (const child of children) await stop(child, 'SIGTERM');
  reader?.close();
  sqlite.close();
}
