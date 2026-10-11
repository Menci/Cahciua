import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../llm/call', () => ({ callLlm: vi.fn() }));

import { defaultQueryLimits } from './budget';
import { historyQueryInstructions } from './instructions';
import { runQueryCode } from './interpreter';
import { createQuerySdk } from './sdk';
import { createHistoryQueryService } from './service';
import { openQuerySnapshot } from './snapshot';
import { executeSnapshotQuery } from './worker';
import { createHistoryArchive } from '../../db/history-archive';
import { persistEvent, persistTurnResponse } from '../../db/persistence';
import * as schema from '../../db/schema';
import { createRunner } from '../../driver/runner';
import { createTool } from '../../driver/tools/create-tool';
import { executeToolCall } from '../../driver/tools/execution';
import { createHistoryQueryTool } from '../../driver/tools/history-query';
import { callLlm } from '../../llm/call';
import { createHistoryAccess } from '../access';
import { buildHistorySlice } from '../bootstrap';
import { openHistoryStore } from '../store';

initLogger(LogLevel.Error, Format.Pretty);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const message = (chatId: string, id: string, text: string, time = 1000, senderId = 'user') => ({
  type: 'message' as const, chatId, messageId: id, receivedAtMs: time, timestampSec: time / 1000, utcOffsetMin: 480,
  sender: { id: senderId, displayName: senderId, isBot: false }, content: [{ type: 'text' as const, text }], attachments: [],
});
const fixture = async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'history-query-'));
  const archivePath = resolve(dir, 'archive.db'); const historyPath = resolve(dir, 'history.db');
  const sqlite = new Database(archivePath); sqlite.pragma('journal_mode=WAL');
  const db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: './drizzle' });
  const store = openHistoryStore(historyPath);
  cleanups.push(() => { store.close(); sqlite.close(); rmSync(dir, { recursive: true, force: true }); });
  persistEvent(db, message('A', '1', '运行时升级 evidence 😀字面_%', 1000));
  persistEvent(db, { ...message('A', '2', 'reply', 1001), replyToMessageId: '1' });
  persistEvent(db, message('A', 'hidden', 'blocked secretneedle', 1002, 'blocked'));
  persistEvent(db, { ...message('A', 'reply-hidden', 'ordinary reply', 1003), replyToMessageId: 'hidden' });
  persistEvent(db, message('A', 'deleted', 'deleted secretneedle', 1004));
  persistEvent(db, { type: 'delete', chatId: 'A', messageIds: ['deleted'], receivedAtMs: 1005, timestampSec: 1, utcOffsetMin: 480 });
  persistEvent(db, message('A', 'long', '😀'.repeat(6000), 1006));
  persistEvent(db, message('B', 'foreign', 'foreign secretneedle', 1000, 'foreign'));
  const turnId = await persistTurnResponse(db, 'A', {
    requestedAtMs: 1000, modelName: 'fixture', inputTokens: 100, outputTokens: 7, cacheReadTokens: 25, cacheWriteTokens: 0,
    entries: [
      { kind: 'message', role: 'assistant', reasoning: undefined, parts: [{ kind: 'toolCall', name: 'bash', callId: 'c', args: '{"cmd":"构建失败"}' }, { kind: 'toolCall', name: 'other', callId: 'missing', args: '{}' }] },
      { kind: 'toolResult', callId: 'c', payload: '{"ok":false,"text":"构建失败 evidence"}', requiresFollowUp: true },
    ],
  });
  db.insert(schema.compactions).values({ chatId: 'A', oldCursorMs: 1000, newCursorMs: 1002, summary: '运行时升级 summaryonlyneedle', createdAt: 2000 }).run();
  db.insert(schema.compactions).values({ chatId: 'B', oldCursorMs: 1000, newCursorMs: 1002, summary: 'foreign summaryonlyneedle', createdAt: 2000 }).run();
  const archive = createHistoryArchive(db);
  for (const generation of ['test', 'old']) for (const chatId of ['A', 'B']) {
    for (;;) {
      const batch = await buildHistorySlice({ archive, store, generation, chatId, archiveIdentity: archivePath, renderIdentity: 'fixture', limits: { rowsPerSecond: 100000 } });
      if (batch.scanComplete) break;
    }
  }
  const scope = { historyPath, archivePath, generation: 'test', chatId: 'A', blockedUserIds: [] as string[] };
  const run = (code: string, blockedUserIds: string[] = [], limits = {}) => executeSnapshotQuery({ ...scope, blockedUserIds, code, limits });
  return { ...scope, sqlite, db, store, run, turnId };
};

describe('actual JS → SDK → scoped SQLite snapshot', () => {
  it('searches literal Unicode, short substrings and summaries through all four SDKs', async () => {
    const f = await fixture();
    const value = await f.run('const hits=await search(\'summaryonlyneedle\',{kinds:[\'summary\']}); const c=await context(hits.items[0].ref); return {hits,range:c.threadFilter,window:c.coveredWindow,stats:await sql(\'SELECT count(*) AS n FROM messages\'),short:await search(\'_%\'),quoted:await search(\'字面_%\')};');
    expect(value.status).toBe('ok');
    const result = (value as { result: Record<string, unknown> }).result;
    expect(JSON.stringify(result)).not.toContain('foreign');
    expect(result).toMatchObject({ hits: { items: [{ kind: 'summary' }] }, range: { afterMs: 1000, beforeMs: 1002 }, short: { items: [{ ref: 'message:1' }, { ref: 'message:2' }] }, quoted: { items: [{ ref: 'message:1' }, { ref: 'message:2' }] } });
    for (const example of historyQueryInstructions.split('\n').filter(line => line.startsWith('Example')))
      await expect(f.run(example.slice(example.indexOf(': ') + 2))).resolves.toMatchObject({ status: 'ok' });
  });
  it('preserves complete output/call/result grouping across pages and full Unicode windows', async () => {
    const f = await fixture();
    const value = await f.run('let page=await thread({afterMs:1000,beforeMs:1002,limit:1}); const items=[...page.items]; while(page.nextCursor){page=await thread({afterMs:1000,beforeMs:1002,limit:1,cursor:page.nextCursor});items.push(...page.items)};return {items,full:await context(\'message:long\',{before:0,after:0,offset:2000,maxChars:3})};');
    expect(value.status).toBe('ok');
    const result = (value as { result: { items: { kind: string; tools?: unknown[] }[]; full: unknown } }).result;
    expect(result.items.map(item => item.kind)).toEqual(['message', 'assistant_text', 'message']);
    expect(result.items[1]!.tools).toHaveLength(2);
    expect(result.full).toMatchObject({ fullText: { text: '😀😀😀', totalLength: 6000, offset: 2000, nextOffset: 2003 } });
  });
  it('retains native FTS, aliases, recursive CTE, JSON, aggregate and window expression power', async () => {
    const f = await fixture();
    const value = await f.run(`return await Promise.all([
      sql("SELECT r.ref,snippet(f.records_fts,0,'[',']','...',12) AS s,f.rank FROM records_fts f JOIN records r ON r.id=f.rowid WHERE f.records_fts MATCH ? ORDER BY f.rank,r.time_ms,r.ref LIMIT 10",'"构建失败"'),
      sql("WITH RECURSIVE chain(ref) AS (SELECT ref FROM messages WHERE message_id='1' UNION ALL SELECT m.ref FROM messages m JOIN chain c ON m.reply_to_ref=c.ref) SELECT * FROM chain"),
      sql("SELECT c.ref,json_extract(c.args_json,'$.cmd') AS cmd,r.result_json,e.usage_json FROM tool_calls c JOIN tool_results r ON r.call_ref=c.ref JOIN outputs o ON o.ref=c.output_ref JOIN executions e ON e.step_ref=o.step_ref JOIN json_each(c.args_json) j ON j.key='cmd'"),
      sql("SELECT sender_id,count(*) AS n,row_number() OVER (ORDER BY sender_id) AS pos FROM messages GROUP BY sender_id HAVING count(*)>0")]);`);
    expect(value.status).toBe('ok');
    const result = (value as { result: unknown[][] }).result;
    expect(result[0]).toHaveLength(2); expect(result[1]).toHaveLength(2);
    expect(result[2]).toMatchObject([{ cmd: '构建失败', usage_json: JSON.stringify({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 25, cacheWriteTokens: 0 }) }]);
    expect(JSON.stringify(result)).not.toContain('foreign');
  });
  it('filters blocked/deleted bodies in helpers, exact refs, relations, raw JSON and FTS', async () => {
    const f = await fixture();
    await persistTurnResponse(f.db, 'A', {
      requestedAtMs: 3000, modelName: 'fixture', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, entries: [
        { kind: 'message', role: 'assistant', reasoning: undefined, parts: [{ kind: 'toolCall', callId: 'hidden-copy', name: 'echo', args: '{"nested":{"text":"blocked secretneedle","user_id":"blocked"}}' }] },
        { kind: 'toolResult', callId: 'hidden-copy', payload: '{"nested":{"text":"blocked secretneedle"}}', requiresFollowUp: true },
      ],
    });
    // A deeply nested JSON string must not turn traversal stack overflow into
    // a caught parse failure that exposes known blocked identity.
    const deepArgs = ['{"nested":'.repeat(10000), '{"user_id":"blocked"}', '}'.repeat(10000)].join('');
    await persistTurnResponse(f.db, 'A', {
      requestedAtMs: 3001, modelName: 'fixture', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, entries: [
        { kind: 'message', role: 'assistant', reasoning: undefined, parts: [{ kind: 'toolCall', callId: 'deep', name: 'deep-identity', args: deepArgs }] },
      ],
    });
    // New generation includes the controlled nested JSON copy.
    const archive = createHistoryArchive(f.db);
    for (;;) { if ((await buildHistorySlice({ archive, store: f.store, generation: 'policy', chatId: 'A', archiveIdentity: f.archivePath, renderIdentity: 'fixture', limits: { rowsPerSecond: 100000 } })).scanComplete) break; }
    const value = await executeSnapshotQuery({ ...f, generation: 'policy', blockedUserIds: ['blocked'], code: 'return {all:await sql(\'SELECT ref,kind,substr(text,1,500) AS text FROM records UNION ALL SELECT ref,kind,substr(text,1,500) AS text FROM records\'),fts:await search(\'secretneedle\'),ref:await context(\'message:hidden\'),deleted:await context(\'message:deleted\'),reply:await context(\'message:reply-hidden\'),foreign:await context(\'message:foreign\'),json:await sql(\'SELECT value FROM tool_results,json_tree(payload_json)\'),deep:await sql("SELECT count(*) AS n FROM tool_calls WHERE tool_name=\'deep-identity\'")};' });
    expect(value.status).toBe('ok');
    const result = (value as { result: unknown }).result;
    expect(result).toMatchObject({ ref: { status: 'redacted' }, deleted: { status: 'redacted' }, reply: { status: 'redacted' }, foreign: { status: 'not_found' }, fts: { items: [] }, deep: [{ n: 0 }] });
    expect(JSON.stringify(result)).not.toContain('secretneedle');
  });
  it.each([
    'SELECT * FROM history_items', 'SELECT * FROM main.history_items', 'SELECT * FROM temp.__history_scope',
    'SELECT * FROM history_fts_data', 'SELECT * FROM main.sqlite_schema', 'SELECT * FROM sqlite_master',
    'SELECT * FROM messages UNION SELECT * FROM history_items', 'SELECT (SELECT item_json FROM history_items) FROM messages',
    'WITH x AS (SELECT * FROM main.history_items) SELECT * FROM x', 'WITH history_items AS (SELECT 1) SELECT * FROM history_items',
    'SELECT 1 IN history_items', 'SELECT * FROM pragma_table_info(?)', "SELECT readfile('/tmp/x')", "SELECT load_extension('x')",
    'SELECT 1; SELECT 2', 'PRAGMA query_only=OFF', 'ATTACH DATABASE ? AS other', 'DELETE FROM messages',
    "SELECT json_extract((SELECT item_json FROM history_items),'$.text')", 'SELECT * FROM json_each((SELECT item_json FROM history_items))',
  ])('rejects full-tree SQL attack: %s', async query => {
    const f = await fixture();
    await expect(f.run(`return await sql(${JSON.stringify(query)},'x');`)).rejects.toMatchObject({ status: 'sql_denied' });
  });
  it('permits safe CTE shadowing, nested/UNION queries, quoted names, JSON and binds injection as data', async () => {
    const f = await fixture();
    const value = await f.run('return await Promise.all([sql(\'WITH messages AS (SELECT ref FROM outputs) SELECT * FROM messages UNION ALL SELECT ref FROM temp.messages\'),sql(\'SELECT * FROM "messages" WHERE text=?\', "\' OR 1=1 --"),sql("SELECT value FROM json_each(\'[1,2]\') WHERE value IN (SELECT value FROM json_tree(\'[1]\') WHERE type=\'integer\')")]);');
    expect(value.status).toBe('ok');
    const result = (value as { result: unknown[][] }).result; expect(result[1]).toEqual([]); expect(result[2]).toEqual([{ value: 1 }]);
  });
  it('rejects host access and expires loops, oversized rows/JSON and stale cursors explicitly', async () => {
    const f = await fixture();
    const value = await f.run('return [typeof process,typeof require,typeof fetch,typeof Buffer,typeof __query_bridge,await search.constructor(\'return typeof process\')()];');
    expect(value).toMatchObject({ status: 'ok', result: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined'] });
    await expect(f.run('while(true){}', [], { deadlineMs: 50 })).rejects.toBeInstanceOf(Error);
    await expect(f.run('return await sql("SELECT * FROM messages")', [], { sqlRows: 1 })).rejects.toMatchObject({ status: 'budget_exceeded' });
    await expect(f.run('return "x".repeat(100000)', [], { resultBytes: 1000 })).rejects.toMatchObject({ status: 'budget_exceeded' });
    const first = await f.run('return await search(\'evidence\',{limit:1})');
    const cursor = (first as { result: { nextCursor: string } }).result.nextCursor;
    await expect(f.run(`return await search('evidence',{limit:1,cursor:${JSON.stringify(cursor)}})`)).rejects.toMatchObject({ status: 'invalid_cursor' });
  });
  it('verifies event sources without mixing changed archive content into transcript', async () => {
    const f = await fixture();
    const before = await f.run('return await context(\'event:1\',{before:0,after:0})'); expect(before).toMatchObject({ status: 'ok', result: { status: 'ok', sourceRef: 'event:1' } });
    f.sqlite.prepare('UPDATE events SET content=? WHERE id=1').run(JSON.stringify([{ type: 'text', text: 'new source content' }]));
    const changed = await f.run('return await context(\'event:1\')'); expect(changed).toMatchObject({ status: 'ok', result: { status: 'source_changed' } });
    const foreign = await f.run('return await context(\'event:8\')'); expect(foreign).toMatchObject({ status: 'ok', result: { status: 'not_found' } });
  });
  it('groups explicitly confirmed self-sends once and retains direct message identity', async () => {
    const f = await fixture();
    persistEvent(f.db, { ...message('A', '77', 'confirmed body', 5000), isSelfSent: true });
    await persistTurnResponse(f.db, 'A', {
      requestedAtMs: 4999, modelName: 'fixture', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      entries: [
        { kind: 'message', role: 'assistant', reasoning: undefined, parts: [{ kind: 'toolCall', name: 'send_message', callId: 'sent', args: '{"text":"confirmed body"}' }] },
        { kind: 'toolResult', callId: 'sent', payload: '{"ok":true,"message_id":77}', requiresFollowUp: false },
      ],
    });
    const turn = (f.sqlite.prepare('SELECT max(id) AS id FROM turn_responses_v2').get() as { id: number }).id;
    for (;;) { if ((await buildHistorySlice({ archive: createHistoryArchive(f.db), store: f.store, generation: 'sent', chatId: 'A', archiveIdentity: f.archivePath, renderIdentity: 'fixture', limits: { rowsPerSecond: 100000 } })).scanComplete) break; }
    const value = await executeSnapshotQuery({ ...f, generation: 'sent', code: 'return {timeline:await thread({afterMs:4999}),message:await context("message:77",{before:0,after:0}),links:await sql("SELECT * FROM links WHERE kind=\'sent_message\'")};' });
    expect(value).toMatchObject({ status: 'ok', result: { timeline: { items: [{ ref: `output:${turn}/entry:0`, tools: [{ sentMessages: [{ ref: 'message:77' }] }] }] }, message: { target: { ref: 'message:77' } }, links: [{ kind: 'sent_message', to_ref: 'message:77' }] } });
    expect((value as { result: { timeline: { items: unknown[] } } }).result.timeline.items).toHaveLength(1);
    const neighbors = await executeSnapshotQuery({ ...f, generation: 'sent', code: `const message=await context('message:77'),call=await context('call:${turn}/entry:0/part:0'); return {message:message.window.map(item=>item.ref),call:call.window.map(item=>item.ref)};` });
    expect(neighbors.status).toBe('ok');
    expect((neighbors as { result: { message: string[]; call: string[] } }).result.message.every(ref => ref !== `output:${turn}/entry:0` && ref !== 'message:77')).toBe(true);
    expect((neighbors as { result: { call: string[] } }).result.call.every(ref => ref !== `output:${turn}/entry:0` && ref !== 'message:77')).toBe(true);
  });
  it('persists query evidence in runner TR before follow-up sends without changing input events', async () => {
    const f = await fixture();
    const service = createHistoryQueryService({ access: createHistoryAccess({ enabled: true }), scope: () => ({ historyPath: f.historyPath, archivePath: f.archivePath, generation: f.generation, chatId: 'A', blockedUserIds: [] }), spawn: entry => fork(entry, ['--history-query-worker'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }) });
    const model = vi.mocked(callLlm); model.mockReset();
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const entries = (name: string, args: string) => [{ kind: 'message' as const, role: 'assistant' as const, reasoning: undefined, parts: [{ kind: 'toolCall' as const, name, callId: name, args }] }];
    model.mockResolvedValueOnce({ entries: entries('history_query', JSON.stringify({ code: 'return await search("summaryonlyneedle",{kinds:["summary"],limit:1})' })), usage })
      .mockImplementationOnce(async (_config, input) => {
        expect(input).toContainEqual(expect.objectContaining({ kind: 'toolResult', callId: 'history_query', requiresFollowUp: true, payload: expect.stringContaining('summaryonlyneedle') }));
        expect(f.sqlite.prepare('SELECT count(*) AS n FROM turn_responses_v2').get()).toEqual({ n: 2 });
        return { entries: entries('send_message', '{"text":"evidence found"}'), usage };
      });
    const send = vi.fn(() => ({ content: '{"ok":true,"message_id":"88"}', requiresFollowUp: false }));
    const before = f.sqlite.prepare('SELECT count(*) AS n FROM events').get();
    try {
      await createRunner({ apiBaseUrl: 'mock', apiKey: 'key', model: 'fixture', apiFormat: 'openai-chat' }).runStepLoop({
        chatId: 'A', entries: [], system: 'fixture', tools: [createHistoryQueryTool(code => service.executeQuery('A', code)), createTool({ name: 'send_message', description: 'fixture', parameters: { type: 'object', properties: { text: { type: 'string' } } }, execute: send })], maxSteps: 3,
        onStepComplete: async (stepEntries, stepUsage, requestedAtMs) => { await persistTurnResponse(f.db, 'A', { requestedAtMs, modelName: 'fixture', entries: stepEntries, ...stepUsage }); }, checkInterrupt: () => false, log: useLogger('test'),
      });
      expect(send).toHaveBeenCalledOnce();
      expect(model).toHaveBeenCalledTimes(2);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM events').get()).toEqual(before);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM turn_responses_v2').get()).toEqual({ n: 3 });
    } finally { await service.stop(); model.mockReset(); }
  }, 15000);
  it('runs the actual subprocess service through the Driver tool result path and releases native SQL on deadline', async () => {
    const f = await fixture();
    const service = createHistoryQueryService({ access: createHistoryAccess({ enabled: true }), scope: () => ({ historyPath: f.historyPath, archivePath: f.archivePath, generation: f.generation, chatId: f.chatId, blockedUserIds: f.blockedUserIds }), limits: { deadlineMs: 2000 }, spawn: entry => fork(entry, ['--history-query-worker'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }) });
    try {
      const tool = createHistoryQueryTool(code => service.executeQuery('A', code));
      const result = await executeToolCall('query', 'history_query', JSON.stringify({ code: 'return await search(\'summaryonlyneedle\',{kinds:[\'summary\']})' }), [tool], useLogger('test'));
      expect(result).toMatchObject({ kind: 'toolResult', callId: 'query', requiresFollowUp: true });
      expect(JSON.parse(result.payload as string)).toMatchObject({ status: 'ok', result: { items: [{ kind: 'summary' }] } });
      const memory = await service.executeQuery('A', 'return await sql("SELECT hex(zeroblob(64000000))")');
      expect(memory.status).toBe('budget_exceeded');
      const timed = await service.executeQuery('A', 'return await sql(\'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n\');');
      expect(timed.status).toBe('deadline_exceeded');
      expect(service.metrics().active).toBe(0);
      f.store.sqlite.prepare('INSERT INTO history_source_changes(generation,change_json) VALUES(?,?)').run('test', '{}');
      expect(f.store.sqlite.pragma('wal_checkpoint(TRUNCATE)')).toMatchObject([{ busy: 0 }]);
    } finally { await service.stop(); }
  }, 15000);
  it('reports only chat coverage, observed lag and explicit incomplete membership without fresh waits', async () => {
    const f = await fixture();
    f.store.sqlite.prepare('UPDATE history_checkpoints SET scan_complete=0 WHERE generation=? AND chat_id=? AND source_kind=?').run('test', 'A', 'events');
    f.store.sqlite.prepare('DELETE FROM history_items WHERE generation=? AND chat_id=? AND item_key=?').run('test', 'A', JSON.stringify(['A', 'message', '1']));
    f.store.sqlite.prepare('INSERT INTO history_consumers(generation,baseline_seq,consume_seq,reconcile_seq,baseline_complete) VALUES(?,0,0,0,1)').run('test');
    for (const chatId of ['A', 'B']) f.store.sqlite.prepare('INSERT INTO history_source_changes(generation,change_json) VALUES(?,?)').run('test', JSON.stringify({ chatId, sourceKind: 'events', sourceKey: '1', targetIds: [], taskIds: [] }));
    for (const [chatId, key] of [['A', 'relevant'], ['B', 'unrelated']]) {
      f.store.sqlite.prepare('INSERT INTO history_media_dependencies(generation,chat_id,message_id,cache_key) VALUES(?,?,?,?)').run('test', chatId, '1', key);
      f.store.sqlite.prepare('INSERT INTO history_source_changes(generation,change_json) VALUES(?,?)').run('test', JSON.stringify({ chatId: null, sourceKind: 'image_alt_texts', sourceKey: key }));
    }
    const value = await f.run("return {missing:await context('message:1'),foreign:await context('message:foreign'),summary:await context('summary:1',{before:0,after:0,limit:1})};");
    expect(value).toMatchObject({ status: 'ok', index: { phase: 'building', baselineComplete: false, lag: { observedChanges: 2 } }, result: { missing: { status: 'not_indexed' }, foreign: { status: 'not_found' } } });
    const empty = await executeSnapshotQuery({ ...f, chatId: 'C', code: 'return await search("absent")' });
    expect(empty).toMatchObject({ status: 'ok', index: { phase: 'not_indexed', baselineComplete: false, coverage: [], lag: { observedChanges: 0 } }, result: { items: [] } });
  });
  it('keeps all SDK calls on one committed snapshot while a writer continues committing', async () => {
    const f = await fixture();
    const snapshot = openQuerySnapshot(f);
    const sdk = createQuerySdk(snapshot, defaultQueryLimits);
    try {
      const before = await runQueryCode('return (await sql("SELECT count(*) AS n FROM messages"))[0].n', sdk, defaultQueryLimits);
      const old = f.store.sqlite.prepare("SELECT item_json AS value FROM history_items WHERE generation='test' AND chat_id='A' AND kind='message' LIMIT 1").get() as { value: string };
      const item = JSON.parse(old.value); item.key = JSON.stringify(['A', 'message', 'new']); item.metadata.messageId = 'new';
      f.store.sqlite.prepare('INSERT INTO history_items(generation,chat_id,item_key,kind,time_ms,source_order,source_id,entry_index,part_index,item_json,search_text) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('test', 'A', item.key, 'message', 4000, 0, 999, -1, -1, JSON.stringify(item), 'new snapshot');
      const after = await runQueryCode('return await Promise.all([sql("SELECT count(*) AS n FROM messages"),search("new snapshot"),thread({afterMs:4000})]);', sdk, defaultQueryLimits) as [{ n: number }[], unknown, unknown];
      expect(after[0][0]!.n).toBe(before);expect(after[1]).toMatchObject({ items: [] });expect(after[2]).toMatchObject({ items: [] });
      expect(f.store.sqlite.pragma('wal_checkpoint(PASSIVE)')).toMatchObject([{ busy: 0 }]);
    } finally {snapshot.close();}
    expect(f.store.sqlite.pragma('wal_checkpoint(TRUNCATE)')).toMatchObject([{ busy: 0 }]);
    expect(await f.run('return await search("new snapshot")')).toMatchObject({ status: 'ok', result: { items: [{ ref: 'message:new' }] } });
  });
  it('enforces SDK calls, memory, SQL bytes/rows, cumulative bytes and final bytes without silent partial success', async () => {
    const f = await fixture();
    await expect(f.run('try{for(let i=0;i<4;i++) await sql("SELECT 1")}catch{}return 1', [], { calls: 2 })).rejects.toMatchObject({ status: 'budget_exceeded' });
    await expect(f.run('return await sql("SELECT text FROM messages")', [], { sdkBytes: 2000 })).rejects.toMatchObject({ status: 'budget_exceeded' });
    await expect(f.run('try{await sql("SELECT * FROM messages")}catch{}return 1', [], { sqlRows: 1 })).rejects.toMatchObject({ status: 'budget_exceeded' });
    await expect(f.run('return await sql("SELECT 1")', [], { sqlBytes: 4 })).rejects.toMatchObject({ status: 'budget_exceeded' });
    await expect(f.run('try{await context("event:1")}catch{}return 1', [], { sdkBytes: 1024 })).rejects.toMatchObject({ status: 'budget_exceeded' });
    await expect(f.run('return new Array(10000000).fill("x")', [], { memoryBytes: 1024 * 1024 })).rejects.toBeInstanceOf(Error);
    await expect(f.run('return 1', [], { resultBytes: 100 })).rejects.toMatchObject({ status: 'budget_exceeded' });
  });
  it('cancels an active native query, serializes same-chat calls and rebinds changed policy on the next child', async () => {
    const f = await fixture(); let policy: string[] = [];
    const children: ReturnType<typeof fork>[] = [];
    // Bind only the declared JSON scope, never test-side host handles.
    const service2 = createHistoryQueryService({ access: createHistoryAccess({ enabled: true }), scope: ()=>({ historyPath: f.historyPath, archivePath: f.archivePath, generation: f.generation, chatId: 'A', blockedUserIds: policy }), limits: { deadlineMs: 4000 }, spawn: entry=>{const child = fork(entry, ['--history-query-worker'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });children.push(child);return child;} });
    try {
      const first = service2.executeQuery('A', 'return await sql("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n")');
      const second = service2.executeQuery('A', 'return await search("evidence")');
      await delay(500);expect(children).toHaveLength(1);await service2.stop();
      expect((await first).status).toBe('cancelled');expect((await second).status).toBe('cancelled');
      expect(service2.metrics().active).toBe(0);expect(f.store.sqlite.pragma('wal_checkpoint(TRUNCATE)')).toMatchObject([{ busy: 0 }]);
    } finally {await service2.stop();}
    const scope = ()=>({ historyPath: f.historyPath, archivePath: f.archivePath, generation: f.generation, chatId: 'A', blockedUserIds: policy });
    const changing = createHistoryQueryService({ access: createHistoryAccess({ enabled: true }), scope, spawn: entry=>fork(entry, ['--history-query-worker'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }) });
    try {expect(await changing.executeQuery('A', 'return await context("message:hidden",{before:0,after:0})')).toMatchObject({ status: 'ok', result: { status: 'ok' } });policy = ['blocked'];expect(await changing.executeQuery('A', 'return await context("message:hidden")')).toMatchObject({ status: 'ok', result: { status: 'redacted' } });} finally {await changing.stop();}
  }, 15000);

});
