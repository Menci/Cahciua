// Run only in an isolated container. Copy with SQLite backup, never copy live
// WAL files. Evidence contains counts, hashes and statuses, not source bodies.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { createHistoryArchive } from '../../src/db/history-archive.ts';
import { loadImageAltTextByHash, persistEvent } from '../../src/db/persistence.ts';
import * as schema from '../../src/db/schema.ts';
import { createHistoryAccess } from '../../src/history/access.ts';
import { buildHistoryInput } from '../../src/history/build-input.ts';
import { createHistoryQueryService } from '../../src/history/query/service.ts';
import { openQuerySnapshot } from '../../src/history/query/snapshot.ts';
import { createCachedAltTextHydrator } from '../../src/media/alt-text-cache.ts';

const { values } = parseArgs({ options: { archive: { type: 'string' }, out: { type: 'string' } } });
assert(values.archive && values.out);
const directory = resolve(values.out);
assert(!existsSync(directory)); mkdirSync(directory, { recursive: true });
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceSchema = database => database.prepare('SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name').all();
const production = new Database(values.archive, { readonly: true, fileMustExist: true });
const schemaBefore = sha(sourceSchema(production));
await production.backup(`${directory}/archive.db`); production.close();
const sqlite = new Database(`${directory}/archive.db`); sqlite.pragma('journal_mode=WAL');
const db = drizzle(sqlite, { schema });
const counts = Object.fromEntries(['events', 'turn_responses_v2', 'compactions'].map(table => [table, sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
const chats = sqlite.prepare('SELECT chat_id FROM events UNION SELECT chat_id FROM turn_responses_v2 UNION SELECT chat_id FROM compactions').all().map(row => row.chat_id);
const chatId = sqlite.prepare('SELECT chat_id FROM events GROUP BY chat_id ORDER BY count(*) DESC LIMIT 1').get().chat_id;
db.insert(schema.compactions).values({ chatId, oldCursorMs: 0, newCursorMs: 2, createdAt: 1, summary: 'queryacceptancemarker' }).run();
const options = { archivePath: `${directory}/archive.db`, historyPath: `${directory}/history.db`, generation: 'query-acceptance' };
const builder = fork(resolve('dist/history-worker.mjs'), ['--history-worker', JSON.stringify(options)], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
let reader;
const waitFor = async read => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) { const value = read(); if (value) return value; await delay(100); }
  throw new Error('Isolated acceptance timed out');
};
const stopBuilder = async () => {
  if (builder.exitCode !== null || builder.signalCode !== null) return;
  await new Promise(done => { const timer = setTimeout(() => builder.kill('SIGKILL'), 2000); builder.once('close', () => { clearTimeout(timer); done(); }); builder.kill('SIGTERM'); });
};
let policy = [];
const scope = () => ({ ...options, chatId, blockedUserIds: policy });
const spawn = () => fork(resolve('dist/history-query-worker.mjs'), ['--history-query-worker'], { execArgv: ['--max-old-space-size=64'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const service = createHistoryQueryService({ access: createHistoryAccess({ enabled: true }), scope, spawn });
try {
  await waitFor(() => {
    if (!existsSync(options.historyPath)) return;
    reader ??= new Database(options.historyPath, { readonly: true });
    if (!reader.prepare("SELECT 1 FROM sqlite_schema WHERE name='history_consumers'").get()) return;
    const state = reader.prepare('SELECT baseline_complete,status_json FROM history_consumers').get();
    const status = state?.status_json ? JSON.parse(state.status_json) : undefined;
    return state?.baseline_complete && status?.completedSourcePolls >= 3 && status.logLag === 0;
  });
  const archive = createHistoryArchive(db);
  const hydrateAltText = createCachedAltTextHydrator({ enabled: () => true, lookup: hash => loadImageAltTextByHash(db, hash) });
  let expectedItems = 0; let mismatches = 0;
  for (const chat of chats) {
    const expected = new Map();
    for await (const batch of buildHistoryInput({ archive, bounds: archive.captureBounds(chat), pageSize: 8, hydrateAltText })) for (const change of batch.changes) expected.set(change.item.key, change.item);
    const actual = reader.prepare('SELECT item_key,item_json FROM history_items WHERE generation=? AND chat_id=?').all(options.generation, chat);
    expectedItems += expected.size;
    if (expected.size !== actual.length) mismatches++;
    for (const row of actual) if (JSON.stringify(expected.get(row.item_key)) !== JSON.stringify(JSON.parse(row.item_json))) mismatches++;
  }
  assert.equal(mismatches, 0);
  const snapshot = openQuerySnapshot(scope());
  const hostCounts = snapshot.sqlite.prepare('SELECT kind,count(*) AS n FROM records GROUP BY kind ORDER BY kind').all();
  const hostFts = snapshot.sqlite.prepare("SELECT r.ref,snippet(f.records_fts,0,'[',']','…',24) AS s,f.rank FROM records_fts f JOIN records r ON r.id=f.rowid WHERE f.records_fts MATCH ? ORDER BY f.rank,r.time_ms,r.ref LIMIT 5").all('"queryacceptancemarker"');
  snapshot.close();
  const began = performance.now();
  const query = await service.executeQuery(chatId, `const h=await search('queryacceptancemarker',{kinds:['summary'],limit:1}); const c=await context(h.items[0].ref,{before:0,after:0,limit:1}); const t=await thread({...c.threadFilter,limit:1}); return {counts:await sql('SELECT kind,count(*) AS n FROM records GROUP BY kind ORDER BY kind'),fts:await sql("SELECT r.ref,snippet(f.records_fts,0,'[',']','…',24) AS s,f.rank FROM records_fts f JOIN records r ON r.id=f.rowid WHERE f.records_fts MATCH ? ORDER BY f.rank,r.time_ms,r.ref LIMIT 5",'"queryacceptancemarker"'),summaryCount:h.items.length,summaryRange:c.threadFilter,window:t.items.length,join:await sql('SELECT count(*) AS n FROM tool_calls c JOIN tool_results r ON r.call_ref=c.ref JOIN outputs o ON o.ref=c.output_ref JOIN executions e ON e.step_ref=o.step_ref')};`);
  assert.equal(query.status, 'ok'); assert.deepEqual(query.result.counts, hostCounts); assert.deepEqual(query.result.fts, hostFts); assert.equal(query.result.summaryCount, 1);
  const queryMs = performance.now() - began;
  const attacks = ['SELECT * FROM main.history_items', 'WITH x AS (SELECT * FROM history_items) SELECT * FROM x', 'SELECT * FROM messages UNION SELECT * FROM history_items', 'SELECT * FROM sqlite_schema', 'SELECT * FROM pragma_table_info(?)', "SELECT readfile('/source/cahciua.db')", "SELECT load_extension('x')", 'SELECT 1; DELETE FROM messages'];
  for (const attack of attacks) assert.equal((await service.executeQuery(chatId, `try{await sql(${JSON.stringify(attack)},'x');return 'escaped'}catch(e){return e.name}`)).result, 'sql_denied');
  const author = reader.prepare("SELECT json_extract(item_json,'$.metadata.sender.id') AS uid,count(*) AS n FROM history_items WHERE generation=? AND chat_id=? AND kind='message' AND uid IS NOT NULL GROUP BY uid ORDER BY n LIMIT 1").get(options.generation, chatId);
  if (author) {
    policy = [author.uid];
    const blocked = await service.executeQuery(chatId, `return await sql('SELECT count(*) AS n FROM messages WHERE sender_id=?',${JSON.stringify(author.uid)})`);
    assert.equal(blocked.result[0].n, 0); policy = [];
  }
  const countBefore = (await service.executeQuery(chatId, 'return (await sql("SELECT count(*) AS n FROM messages"))[0].n')).result;
  const concurrent = service.executeQuery(chatId, 'const before=(await sql("SELECT count(*) AS n FROM messages"))[0].n; const end=Date.now()+3000;while(Date.now()<end){};return {before,after:(await sql("SELECT count(*) AS n FROM messages"))[0].n,hits:(await search("snapshotacceptancemarker")).items.length};');
  await delay(1000);
  const message = (id, text) => ({ type: 'message', chatId, messageId: id, receivedAtMs: Date.now(), timestampSec: Math.floor(Date.now()/1000), utcOffsetMin: 480, sender: { id: 'query-acceptance', displayName: 'fixture', isBot: false }, content: [{ type: 'text', text }], attachments: [] });
  persistEvent(db, message('query-acceptance-1', 'snapshotacceptancemarker'));
  await waitFor(() => reader.prepare("SELECT 1 FROM history_items WHERE generation=? AND chat_id=? AND search_text LIKE '%snapshotacceptancemarker%'").get(options.generation, chatId));
  const concurrentResult = await concurrent;
  assert.equal(concurrentResult.status, 'ok'); assert.deepEqual(concurrentResult.result, { before: countBefore, after: countBefore, hits: 0 });
  const next = await service.executeQuery(chatId, 'return (await search("snapshotacceptancemarker")).items.length'); assert.equal(next.result, 1);
  const timedService = createHistoryQueryService({ access: createHistoryAccess({ enabled: true }), scope, spawn, limits: { deadlineMs: 1500 } });
  const timeoutBegan = performance.now();
  const timeout = timedService.executeQuery(chatId, 'return await sql("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n");');
  await delay(300); persistEvent(db, message('query-acceptance-2', 'deadlineacceptancemarker'));
  await waitFor(() => reader.prepare("SELECT 1 FROM history_items WHERE generation=? AND chat_id=? AND search_text LIKE '%deadlineacceptancemarker%'").get(options.generation, chatId));
  assert.equal((await timeout).status, 'deadline_exceeded'); const timeoutMs = performance.now() - timeoutBegan;
  await timedService.stop(); assert.equal(timedService.metrics().active, 0);
  await service.stop(); await stopBuilder(); reader.close(); reader = undefined;
  const checkpoint = new Database(options.historyPath); const released = checkpoint.pragma('wal_checkpoint(TRUNCATE)'); assert.equal(released[0].busy, 0); assert.equal(checkpoint.pragma('integrity_check', { simple: true }), 'ok'); checkpoint.close();
  const productionAfter = new Database(values.archive, { readonly: true }); const schemaAfter = sha(sourceSchema(productionAfter)); productionAfter.close(); assert.equal(schemaBefore, schemaAfter);
  const evidence = { runtime: process.version, builtBuilder: true, builtQueryWorker: true, defaultBuilderLimits: true, counts, chats: chats.length, expectedItems, mismatches, publicCounts: hostCounts, hostSqlAndFtsAgreement: true, helperMethods: 4, summaryNavigation: true, policyRebinding: !!author, deniedAttacks: attacks.length, queryMs, snapshotConsistency: true, writerProgressDuringQuery: true, writerProgressDuringNativeSql: true, timeoutMs, processDeadlineMs: 1500, processReleased: true, walCheckpoint: released, integrity: 'ok', schemaBefore, schemaAfter, productionModified: false };
  writeFileSync(`${directory}/evidence.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { await service.stop(); await stopBuilder(); reader?.close(); sqlite.close(); }
