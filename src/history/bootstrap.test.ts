import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildHistorySlice } from './bootstrap';
import { defaultHistoryLimits } from './budget';
import { buildHistoryInput } from './build-input';
import * as historySchema from './schema';
import { openHistoryStore, searchableText } from './store';
import type { HistoryCommit } from './store';
import { compareHistoryOrder } from './turn-items';
import type { HistoryItem } from './types';
import { codec } from '../db/codec';
import { createHistoryArchive } from '../db/history-archive';
import { persistEvent, persistTurnResponse } from '../db/persistence';
import * as schema from '../db/schema';
import type { PipelineEvent } from '../projection';
import type { ConversationEntry } from '../unified-api/types';

const directories: string[] = [];
const connections: Database.Database[] = [];
afterEach(() => {
  connections.splice(0).forEach(db => { if (db.open) db.close(); });
  directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
const fixture = () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'history-bootstrap-'));
  directories.push(dir);
  const archivePath = resolve(dir, 'archive.db');
  const sqlite = new Database(archivePath);
  connections.push(sqlite);
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  const archive = createHistoryArchive(db);
  return { dir, archivePath, sqlite, db, archive };
};
const message = (messageId: string, at = 1000, text = messageId, chatId = 'chat'): Extract<PipelineEvent, { type: 'message' }> => ({
  type: 'message', chatId, messageId, receivedAtMs: at, timestampSec: Math.floor(at / 1000), utcOffsetMin: 480,
  sender: { id: 'user', displayName: 'User', isBot: false }, content: [{ type: 'text', text }], attachments: [],
});
const sortItems = (items: HistoryItem[]) => items.sort((a, b) => compareHistoryOrder(a.order, b.order));
const readItems = (path: string, generation = 'g') => {
  const store = openHistoryStore(path);
  try { return sortItems(store.db.select().from(historySchema.savedItems).where(eq(historySchema.savedItems.generation, generation)).all().map(row => row.item)); } finally { store.close(); }
};
const deps = (f: ReturnType<typeof fixture>, _path: string, rows = 5, generation = 'g', chatId = 'chat') => ({
  archive: f.archive, generation, chatId, archiveIdentity: f.archivePath, renderIdentity: 'test',
  limits: { maxRowsPerSlice: rows, rowsPerSecond: 100000 },
});
const finish = async (f: ReturnType<typeof fixture>, path: string, rows = 5, generation = 'g', chatId = 'chat') => {
  let count = 0;
  let peakEntries = 0;
  let peakBytes = 0;
  for (;;) {
    const store = openHistoryStore(path);
    try {
      const slice = await buildHistorySlice({ ...deps(f, path, rows, generation, chatId), store });
      count += slice.processedRows;
      peakEntries = Math.max(peakEntries, slice.peakStateEntries);
      peakBytes = Math.max(peakBytes, slice.peakEncodedWorkspaceBytes);
      if (slice.scanComplete) return { count, peakEntries, peakBytes };
    } finally { store.close(); }
  }
};
const populate = async (f: ReturnType<typeof fixture>, chatId = 'chat') => {
  const text = 'original full searchable content <&> '.repeat(200);
  const events: PipelineEvent[] = [
    message('1', 1000, text, chatId),
    { ...message('2', 1000, 'reply', chatId), replyToMessageId: '1' },
    { ...message('1', 2000, 'editedneedle', chatId), type: 'edit' },
    { ...message('new-user', 2100, 'name changed', chatId), sender: { id: 'user', displayName: 'Renamed', isBot: false } },
    { type: 'delete', chatId, messageIds: ['1', 'missing'], receivedAtMs: 3000, timestampSec: 3, utcOffsetMin: 480 },
    { ...message('3', 4000, 'synthetic', chatId), isSelfSent: true },
    { ...message('3', 5000, 'authoritative', chatId), sender: { id: 'bot', displayName: 'Bot', isBot: true } },
    { ...message('4', 6000, 'after delete', chatId), replyToMessageId: '1' },
    { ...message('5', 7000, 'quoted', chatId), replyToMessageId: '1', replyQuoteContent: [{ type: 'bold', children: [{ type: 'text', text }] }] },
    { type: 'service', chatId, receivedAtMs: 7500, timestampSec: 7, utcOffsetMin: 0, action: { action: 'chat_renamed', newTitle: 'Title' } },
    { type: 'service', chatId, receivedAtMs: 7600, timestampSec: 7, utcOffsetMin: 0, action: { action: 'message_pinned', messageId: '1' } },
    ...[7, 8].map(taskId => ({
      type: 'runtime' as const, chatId, receivedAtMs: 9000, timestampSec: 9, utcOffsetMin: 480,
      kind: 'task_completed' as const, taskId, taskType: 'bash', finalSummary: 'completionneedle '.repeat(300), hasFullOutput: true,
    })),
  ];
  events.forEach(event => persistEvent(f.db, event));
  const entries: ConversationEntry[] = [{
    kind: 'message', role: 'assistant', reasoning: undefined,
    parts: [{ kind: 'text', text: 'outputneedle '.repeat(300) }, { kind: 'toolCall', callId: 'same', name: 'bash', args: '{"command":"argsneedle"}' }],
  }, { kind: 'toolResult', callId: 'same', payload: '{"background_task_id":7,"text":"resultneedle"}', requiresFollowUp: false }];
  await persistTurnResponse(f.db, chatId, { entries, requestedAtMs: 1000, modelName: 'test', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
  f.db.insert(schema.compactions).values(Array.from({ length: 4 }, (_, i) => ({
    chatId, oldCursorMs: i * 1000, newCursorMs: (i + 1) * 1000, createdAt: 1000, summary: `summaryneedle ${i} ${'full '.repeat(500)}`,
  }))).run();
};

describe('durable historical bootstrap', () => {
  it('builds a multi-megabyte text/tool TR using defaults and preserves full searchable content', async () => {
    const f = fixture();
    const text = 'assistant '.repeat(300000);
    const payload = 'tool result '.repeat(300000);
    await persistTurnResponse(f.db, 'chat', {
      entries: [
        { kind: 'message', role: 'assistant', reasoning: undefined, parts: [{ kind: 'text', text }, { kind: 'toolCall', name: 'bash', callId: 'large', args: '{}' }] },
        { kind: 'toolResult', callId: 'large', payload, requiresFollowUp: false },
      ], requestedAtMs: 1000, modelName: 'test', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    const path = resolve(f.dir, 'default-large.db');
    await finish(f, path, 1);
    const items = readItems(path);
    expect(items.find(item => item.kind === 'model-output')).toMatchObject({ parts: [{ text }] });
    expect(items.find(item => item.kind === 'tool-result')).toMatchObject({ payload, pairing: 'matched' });
  });

  it('converges with the production input builder after every-row restarts and different slice sizes, across chats/generations', async () => {
    const f = fixture();
    await populate(f);
    await populate(f, 'other');
    const uninterrupted = resolve(f.dir, 'one.db');
    const restarted = resolve(f.dir, 'restart.db');
    const wide = resolve(f.dir, 'wide.db');
    await finish(f, uninterrupted, 100);
    await finish(f, restarted, 1);
    await finish(f, wide, 7);
    const expected = new Map<string, HistoryItem>();
    for await (const batch of buildHistoryInput({ archive: f.archive, bounds: f.archive.captureBounds('chat'), pageSize: 3 }))
      for (const change of batch.changes) expected.set(change.item.key, change.item);
    expect(readItems(restarted)).toEqual(sortItems([...expected.values()]));
    expect(readItems(wide)).toEqual(readItems(uninterrupted));
    expect(readItems(restarted)).toEqual(readItems(uninterrupted));
    const readEvents = vi.spyOn(f.archive, 'readEvents');
    expect((await finish(f, restarted, 2)).count).toBe(0);
    expect(readEvents).not.toHaveBeenCalled();
    await finish(f, restarted, 2, 'g', 'other');
    expect(readItems(restarted).filter(item => item.chatId === 'other')).toHaveLength(expected.size);
    await finish(f, restarted, 4, 'new');
    expect(readItems(restarted, 'new')).toEqual(readItems(uninterrupted));
    const store = openHistoryStore(restarted);
    try {
      const states = store.db.select().from(historySchema.userStates).all();
      expect(states.find(row => row.generation === 'g' && row.chatId === 'chat' && row.userId === 'user')!.state).toMatchObject({ messageCount: 6, user: { displayName: 'User' } });
      expect(store.db.select().from(historySchema.chatStates).all().every(row => row.title === 'Title')).toBe(true);
      expect(store.db.select().from(historySchema.notices).all()).toHaveLength(3);
      expect(store.db.select().from(historySchema.messageRevisions).all()).toHaveLength(27);
      const chain = store.db.select().from(historySchema.messageRevisions).where(eq(historySchema.messageRevisions.messageId, '1')).all().filter(row => row.generation === 'g' && row.chatId === 'chat');
      expect(chain[1]!.parentRevision).toBe(chain[0]!.revision);
      expect(chain[2]!.parentRevision).toBe(chain[1]!.revision);
    } finally { store.close(); }
  });

  it('keeps full FTS content, all summaries and tool/reply relationships transactionally consistent', async () => {
    const f = fixture();
    await populate(f);
    const path = resolve(f.dir, 'history.db');
    await finish(f, path, 1);
    const store = openHistoryStore(path);
    try {
      const items = store.db.select().from(historySchema.savedItems).all();
      for (const row of items) expect(row.searchText).toBe(searchableText(row.item));
      for (const [word, count] of [['summaryneedle', 4], ['outputneedle', 1], ['argsneedle', 1], ['completionneedle', 1], ['resultneedle', 1], ['editedneedle', 3]] as const) {
        const matches = store.sqlite.prepare('SELECT i.* FROM history_fts f JOIN history_items i ON i.id = f.rowid WHERE history_fts MATCH ? AND i.generation = ? AND i.chat_id = ?').all(word, 'g', 'chat');
        expect(matches).toHaveLength(count);
      }
      expect(store.db.select().from(historySchema.relations).all().map(row => row.kind).sort()).toEqual(['call', 'output', 'reply', 'reply', 'reply', 'result', 'tool-member']);
      store.sqlite.prepare("INSERT INTO history_fts(history_fts, rank) VALUES ('integrity-check', 1)").run();
    } finally { store.close(); }
  });

  it('rolls back items, state, relations, FTS and cursor on transaction failure; committed batches are idempotent', async () => {
    const f = fixture();
    persistEvent(f.db, { ...message('1'), replyToMessageId: 'missing' });
    const path = resolve(f.dir, 'failure.db');
    const store = openHistoryStore(path);
    let failedPlan: HistoryCommit | undefined;
    const commit = store.commit;
    store.commit = plan => { failedPlan = plan; return commit(plan); };
    try {
      store.sqlite.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON history_checkpoints WHEN new.source_kind = 'events' BEGIN SELECT RAISE(ABORT, 'injected writer failure'); END;");
      await expect(buildHistorySlice({ ...deps(f, path), store })).rejects.toThrow('source=events');
      expect(store.checkpoint('g', 'chat', 'events').after).toBeUndefined();
      expect(store.db.select().from(historySchema.savedItems).all()).toEqual([]);
      expect(store.db.select().from(historySchema.messageStates).all()).toEqual([]);
      expect(store.db.select().from(historySchema.relations).all()).toEqual([]);
      expect(store.db.select().from(historySchema.userStates).all()).toEqual([]);
      expect(store.db.select().from(historySchema.messageRevisions).all()).toEqual([]);
      expect(store.sqlite.prepare("SELECT rowid FROM history_fts WHERE history_fts MATCH '1'").all()).toEqual([]);
      store.sqlite.exec('DROP TRIGGER fail_checkpoint');
      expect(store.commit(failedPlan!)).toBe('committed');
      expect(store.commit(failedPlan!)).toBe('duplicate');
      expect(store.db.select().from(historySchema.messageRevisions).all()).toHaveLength(1);
      expect(store.db.select().from(historySchema.userStates).all()[0]!.state.messageCount).toBe(1);
      expect(() => store.commit({ ...failedPlan!, batch: { ...failedPlan!.batch, progress: { ...failedPlan!.batch.progress, after: { id: 2, timeMs: 2000 } } } })).toThrow('Stale');
    } finally { store.close(); }
    expect((await finish(f, path, 1)).count).toBe(0);
    expect(readItems(path)).toHaveLength(1);
  });

  it('recovers an actual process exit during the writer transaction without replaying committed prefixes', async () => {
    const f = fixture();
    persistEvent(f.db, message('1'));
    persistEvent(f.db, message('2', 2000));
    const path = resolve(f.dir, 'crash.db');
    const store = openHistoryStore(path);
    await buildHistorySlice({ ...deps(f, path, 1), store });
    store.close();
    const script = resolve(f.dir, 'crash.mts');
    writeFileSync(script, `
import Database from ${JSON.stringify(resolve('node_modules/better-sqlite3/lib/index.js'))};
import { drizzle } from ${JSON.stringify(resolve('node_modules/drizzle-orm/better-sqlite3/index.js'))};
import { createHistoryArchive } from ${JSON.stringify(resolve('src/db/history-archive.ts'))};
import { openHistoryStore } from ${JSON.stringify(resolve('src/history/store.ts'))};
import { buildHistorySlice } from ${JSON.stringify(resolve('src/history/bootstrap.ts'))};
import * as schema from ${JSON.stringify(resolve('src/db/schema.ts'))};
const sqlite = new Database(${JSON.stringify(f.archivePath)}, {readonly:true});
const archive = createHistoryArchive(drizzle(sqlite, {schema}));
const store = openHistoryStore(${JSON.stringify(path)});
store.sqlite.function('crash', () => process.exit(29));
store.sqlite.exec("CREATE TEMP TRIGGER crash_checkpoint BEFORE UPDATE ON history_checkpoints WHEN new.source_kind = 'events' BEGIN SELECT crash(); END;");
await buildHistorySlice({archive, store, generation:'g', chatId:'chat', archiveIdentity:${JSON.stringify(f.archivePath)}, renderIdentity:'test', limits:{rowsPerSecond:100000}});
`);
    const child = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), script], { encoding: 'utf8', timeout: 30000 });
    expect(child.status, child.stderr).toBe(29);
    expect(readItems(path)).toHaveLength(1);
    const read = vi.spyOn(f.archive, 'readEvents');
    expect((await finish(f, path, 1)).count).toBe(1);
    expect(read.mock.calls[0]![0].after).toEqual({ timeMs: 1000, id: 1 });
    expect(readItems(path)).toHaveLength(2);
  });

  it('preserves captured fences, rejects changed identities, and stops oversized sources/dependencies without advancing', async () => {
    const f = fixture();
    persistEvent(f.db, message('1', 1000, 'x'.repeat(20000)));
    const path = resolve(f.dir, 'budget.db');
    const store = openHistoryStore(path);
    try {
      await expect(buildHistorySlice({ ...deps(f, path), store, limits: { maxSourceBytes: 1000 } })).rejects.toThrow('source=events');
      expect(store.checkpoint('g', 'chat', 'events').after).toBeUndefined();
      persistEvent(f.db, message('outside', 500));
      await buildHistorySlice({ ...deps(f, path), store });
      expect(store.db.select().from(historySchema.savedItems).all()).toHaveLength(1);
      await expect(buildHistorySlice({ ...deps(f, path), store, renderIdentity: 'changed' })).rejects.toThrow('identity/version mismatch');
      await expect(buildHistorySlice({ ...deps(f, path), store, archiveIdentity: 'another' })).rejects.toThrow('identity/version mismatch');
      store.db.update(historySchema.generations).set({ projectionVersion: 0 }).run();
      await expect(buildHistorySlice({ ...deps(f, path), store })).rejects.toThrow('identity/version mismatch');
    } finally { store.close(); }
    persistEvent(f.db, { ...message('2', 2000), replyToMessageId: '1' });
    const another = openHistoryStore(resolve(f.dir, 'deps.db'));
    try {
      await buildHistorySlice({ ...deps(f, path, 1, 'new'), store: another });
      await expect(buildHistorySlice({ ...deps(f, path, 1, 'new'), store: another, limits: { maxStateEntries: 1 } })).rejects.toThrow('source=events');
      expect(another.checkpoint('new', 'chat', 'events').after).toEqual({ timeMs: 500, id: 2 });
    } finally { another.close(); }
  });

  it('runs the standalone readonly-archive CLI and resumes its completed checkpoint', async () => {
    const f = fixture();
    await populate(f);
    const path = resolve(f.dir, 'cli.db');
    const args = ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/history/cli.ts'),
      '--archive', f.archivePath, '--history', path, '--generation', 'g', '--chat', 'chat', '--rows-per-slice', '3', '--rows-per-second', '100000'];
    const child = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
    expect(child.status, child.stderr).toBe(0);
    const reports = child.stdout.trim().split('\n').map(line => JSON.parse(line) as { scanComplete: boolean; processedRows: number });
    expect(reports.at(-1)!.scanComplete).toBe(true);
    expect(reports.every(report => report.processedRows <= 3)).toBe(true);
    const again = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).processedRows).toBe(0);
    expect(readItems(path).filter(item => item.kind === 'summary')).toHaveLength(4);
    expect(() => openHistoryStore(f.archivePath)).toThrow('Refusing to migrate an archive');
  });

  it('preflights oversized encoded IR before decoding, limits tool expansion and leaves summary work pending', async () => {
    const f = fixture();
    await persistTurnResponse(f.db, 'chat', {
      entries: [{ kind: 'message', role: 'assistant', reasoning: undefined, parts: [{ kind: 'text', text: 'x'.repeat(10000) }] }],
      requestedAtMs: 1000, modelName: 'test', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    const path = resolve(f.dir, 'ir.db');
    const store = openHistoryStore(path);
    const parse = vi.spyOn(codec, 'parse');
    try {
      await expect(buildHistorySlice({ ...deps(f, path), store, limits: { maxSourceBytes: 1000 } })).rejects.toThrow('source=turn_responses_v2');
      expect(parse).not.toHaveBeenCalled();
      expect(store.checkpoint('g', 'chat', 'turn_responses_v2').after).toBeUndefined();
      store.close();
      await finish(f, path, 1);
    } finally { parse.mockRestore(); if (store.sqlite.open) store.close(); }
    f.db.insert(schema.compactions).values({ chatId: 'chat', oldCursorMs: 0, newCursorMs: 1000, createdAt: 1000, summary: 'x'.repeat(10000) }).run();
    const summary = openHistoryStore(resolve(f.dir, 'summary.db'));
    try {
      // Finish the TR prefix with enough budget, then fail just the summary.
      await buildHistorySlice({ ...deps(f, path, 1, 'summary'), store: summary });
      await expect(buildHistorySlice({ ...deps(f, path, 1, 'summary'), store: summary, limits: { maxSourceBytes: 1000 } })).rejects.toThrow('source=compactions');
      expect(summary.checkpoint('summary', 'chat', 'compactions').after).toBeUndefined();
    } finally { summary.close(); }
    const entries: ConversationEntry[] = [{
      kind: 'message', role: 'assistant', reasoning: undefined,
      parts: Array.from({ length: 30 }, (_, i) => ({ kind: 'toolCall' as const, callId: String(i), name: 'bash', args: '{}' })),
    }];
    await persistTurnResponse(f.db, 'other', { entries, requestedAtMs: 1000, modelName: 'test', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const tools = openHistoryStore(resolve(f.dir, 'tools.db'));
    try {
      await expect(buildHistorySlice({ ...deps(f, path, 1, 'tools', 'other'), store: tools, limits: { maxOutputItems: 3 } })).rejects.toThrow('source=turn_responses_v2');
      expect(tools.db.select().from(historySchema.savedItems).all()).toHaveLength(0);
    } finally { tools.close(); }
  });

  it('restores bounded task candidates, retaining ambiguity and notices after repeated restarts', async () => {
    const f = fixture();
    for (let i = 0; i < 40; i++) await persistTurnResponse(f.db, 'chat', {
      entries: [{ kind: 'message', role: 'assistant', reasoning: undefined, parts: [{ kind: 'toolCall', callId: 'same', name: 'bash', args: '{}' }] },
        { kind: 'toolResult', callId: 'same', payload: '{"background_task_id":7}', requiresFollowUp: false }],
      requestedAtMs: 1000, modelName: 'test', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    persistEvent(f.db, {
      type: 'runtime', chatId: 'chat', receivedAtMs: 2000, timestampSec: 2, utcOffsetMin: 0,
      kind: 'task_completed', taskId: 7, taskType: 'bash', finalSummary: 'complete', hasFullOutput: true,
    });
    const path = resolve(f.dir, 'tasks.db');
    const result = await finish(f, path, 3);
    expect(result.peakEntries).toBe(0);
    const store = openHistoryStore(path);
    try {
      expect(store.db.select().from(historySchema.taskStarts).all()).toHaveLength(40);
      expect(store.db.select().from(historySchema.notices).all()[0]!.notice.kind).toBe('ambiguous-task-completion');
      expect(store.db.select().from(historySchema.savedItems).all().filter(row => row.item.kind === 'tool-execution' && row.item.completion)).toHaveLength(0);
    } finally { store.close(); }
  });

  it('preflights recovered state bytes and pages multi-target deletes within the same small budget', async () => {
    const f = fixture();
    persistEvent(f.db, message('1', 1000, 'full '.repeat(3000)));
    persistEvent(f.db, { ...message('1', 2000, 'edited'), type: 'edit' });
    const path = resolve(f.dir, 'state-bytes.db');
    const store = openHistoryStore(path);
    try {
      await buildHistorySlice({ ...deps(f, path, 1), store });
      await expect(buildHistorySlice({ ...deps(f, path, 1), store, limits: { maxWorkspaceBytes: 12 * 1024 } })).rejects.toMatchObject({ cause: { message: expect.stringContaining('workspace exceeds encoded byte budget') } });
      expect(store.checkpoint('g', 'chat', 'events').after).toEqual({ timeMs: 1000, id: 1 });
      expect(store.db.select().from(historySchema.savedItems).all()[0]!.searchText).toBe('full '.repeat(3000));
      await buildHistorySlice({ ...deps(f, path, 1), store });
      expect(store.db.select().from(historySchema.savedItems).all()[0]!.searchText).toBe('edited');
    } finally { store.close(); }
    for (let i = 0; i < 6; i++) persistEvent(f.db, message(String(i), 1000, 'message', 'other'));
    persistEvent(f.db, { type: 'delete', chatId: 'other', messageIds: Array.from({ length: 6 }, (_, i) => String(i)), receivedAtMs: 3000, timestampSec: 3, utcOffsetMin: 0 });
    const many = openHistoryStore(resolve(f.dir, 'delete.db'));
    try {
      await buildHistorySlice({ ...deps(f, path, 6, 'many', 'other'), store: many });
      const small = { ...deps(f, path, 1, 'many', 'other'), store: many, limits: { maxStateEntries: 5, maxRowsPerSlice: 1, rowsPerSecond: 100000 } };
      const first = await buildHistorySlice(small);
      expect(first.peakStateEntries).toBeLessThanOrEqual(5);
      expect(many.checkpoint('many', 'other', 'events').after!.timeMs).toBe(1000);
      expect(many.db.select().from(historySchema.savedItems).all().filter(row => row.item.kind === 'message' && row.item.metadata.deleted)).toHaveLength(1);
      while (!(await buildHistorySlice(small)).scanComplete) { /* Resume bounded deletion work. */ }
      expect(many.db.select().from(historySchema.savedItems).all().every(row => row.item.kind === 'message' && row.item.metadata.deleted)).toBe(true);
    } finally { many.close(); }
  });

  it('bounds serialized dependency residency as unique message/user history grows and uses indexed keyset queries', async () => {
    const f = fixture();
    const path = resolve(f.dir, 'scale.db');
    f.sqlite.transaction(() => {
      for (let i = 0; i < 300; i++) persistEvent(f.db, { ...message(String(i), i), sender: { id: String(i), displayName: 'User', isBot: false } });
    })();
    const small = await finish(f, path, 47);
    f.sqlite.transaction(() => {
      for (let i = 300; i < 3000; i++) persistEvent(f.db, { ...message(String(i), i), sender: { id: String(i), displayName: 'User', isBot: false } });
    })();
    const large = await finish(f, path, 71, 'large');
    expect(small.count).toBe(300);
    expect(large.count).toBe(3000);
    expect(small.peakEntries).toBe(2);
    expect(large.peakEntries).toBe(2);
    expect(large.peakBytes).toBeLessThan(small.peakBytes * 1.1);
    expect(large.peakBytes).toBeLessThan(defaultHistoryLimits.maxWorkspaceBytes);
    const plan = f.sqlite.prepare('EXPLAIN QUERY PLAN SELECT * FROM events WHERE chat_id = ? AND id <= ? AND (received_at, id) > (?, ?) ORDER BY received_at, id LIMIT 1').all('chat', 3000, 100, 101);
    const detail = JSON.stringify(plan);
    expect(detail).toContain('events_chat_id_idx');
    // The existing source schema has no history-specific time index; SQLite
    // sorts this operator-only offline query. Online ordering lives in history.db.
    expect(detail).toContain('TEMP B-TREE');
    const store = openHistoryStore(path);
    try {
      expect(store.db.select().from(historySchema.messageStates).all()).toHaveLength(3300);
      expect(store.db.select().from(historySchema.userStates).all()).toHaveLength(3300);
    } finally { store.close(); }
  }, 60000);
});
