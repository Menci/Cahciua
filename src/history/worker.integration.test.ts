import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';

import { createHistoryAccess } from './access';
import { buildHistoryInput } from './build-input';
import { createHistoryRuntime } from './runtime';
import type { HistoryItem } from './types';
import { createHistoryArchive } from '../db/history-archive';
import { persistEvent, persistImageAltText, persistTurnResponse } from '../db/persistence';
import * as schema from '../db/schema';

initLogger(LogLevel.Error, Format.Pretty);
const waitFor = async <T>(read: () => T | undefined, timeout = 15000): Promise<T> => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = read(); if (value !== undefined) return value; await delay(25); }
  throw new Error('Integration deadline exceeded');
};
const message = (id: string, text = id, time = 1000, chatId = 'A') => ({ type: 'message' as const, chatId, messageId: id, receivedAtMs: time, timestampSec: time / 1000, utcOffsetMin: 480, content: [{ type: 'text' as const, text }], attachments: [] });

it('runs producer + independent writer through bootstrap, SIGKILL/restart, reliable inputs and bounded shutdown with backlog', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'history-process-'));
  const archivePath = resolve(dir, 'archive.db'); const historyPath = resolve(dir, 'history.db');
  const sqlite = new Database(archivePath); sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: './drizzle' });
  const children: ChildProcess[] = [];
  const runtime = createHistoryRuntime({
    access: createHistoryAccess({ enabled: true }),
    options: () => ({ archivePath, historyPath, generation: 'integration', limits: { rowsPerSecond: 100, maxRowsPerSlice: 2 } }),
    logger: useLogger('integration'), restartMs: 50, shutdownMs: 1000,
    spawn: (entry, args) => { const child = fork(entry, [...args], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child); return child; },
  });
  let reader: Database.Database | undefined;
  try {
    for (let i = 0; i < 100; i++) persistEvent(db, message(String(i), `seed ${i}`, 1000 + i));
    const began = performance.now(); runtime.start();
    expect(performance.now() - began).toBeLessThan(250);
    await waitFor(() => runtime.metrics().ready ? true : undefined);
    reader = new Database(historyPath, { readonly: true });
    await waitFor(() => {
      const c = reader!.prepare("SELECT after_json FROM history_checkpoints WHERE source_kind='events'").get() as { after_json: string | null };
      return c.after_json && JSON.parse(c.after_json).id >= 5 ? true : undefined;
    });
    children[0]!.kill('SIGKILL');
    persistEvent(db, message('offline', 'offline insertion', 500));
    persistEvent(db, { ...message('2', 'edit', 2000), type: 'edit' });
    persistEvent(db, { type: 'delete', chatId: 'A', messageIds: ['3'], receivedAtMs: 3000, timestampSec: 3, utcOffsetMin: 480 });
    persistEvent(db, message('new-group', 'new group', 500, 'B'));
    db.insert(schema.compactions).values({ chatId: 'A', oldCursorMs: 0, newCursorMs: 1000, createdAt: 2000, summary: 'searchable summaryneedle' }).run();
    await persistTurnResponse(db, 'A', {
      entries: [
        { kind: 'message', role: 'assistant', reasoning: undefined, parts: [{ kind: 'toolCall', name: 'bash', callId: 'c', args: '{}' }] },
        { kind: 'toolResult', callId: 'c', payload: '{"background_task_id":8}', requiresFollowUp: false },
      ], requestedAtMs: 4000, modelName: 'fixture', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    persistEvent(db, { type: 'runtime', chatId: 'A', kind: 'task_completed', taskId: 8, taskType: 'bash', finalSummary: 'completionneedle', hasFullOutput: true, receivedAtMs: 5000, timestampSec: 5, utcOffsetMin: 480 });
    await waitFor(() => children.length >= 2 && runtime.metrics().ready ? true : undefined);
    const live = message('reused', 'reuse needle', 6000); persistEvent(db, live);
    await waitFor(() => {
      const c = reader!.prepare('SELECT baseline_complete, consume_seq, status_json FROM history_consumers').get() as { baseline_complete: number; consume_seq: number; status_json: string | null };
      const status = c.status_json ? JSON.parse(c.status_json) : undefined;
      return c.baseline_complete && status?.completedSourcePolls >= 2 && status.logLag === 0 && !status.buildInputBacklog ? true : undefined;
    });
    const items = (reader.prepare('SELECT item_json FROM history_items ORDER BY item_key').all() as { item_json: string }[]).map(row => JSON.parse(row.item_json) as HistoryItem);
    const expected = new Map<string, HistoryItem>();
    for (const chatId of ['A', 'B']) for await (const batch of buildHistoryInput({ archive: createHistoryArchive(db), bounds: createHistoryArchive(db).captureBounds(chatId), pageSize: 4 })) for (const change of batch.changes) expected.set(change.item.key, change.item);
    expect(items).toEqual([...expected.values()].sort((a, b) => a.key.localeCompare(b.key)));
    // Backlog must survive finite shutdown rather than being synchronously drained.
    for (let i = 0; i < 100; i++) persistEvent(db, message(`backlog-${i}`));
    const stopAt = performance.now(); await runtime.stop();
    expect(performance.now() - stopAt).toBeLessThan(2000);
    const observed = (reader.prepare("SELECT count(*) AS count FROM history_source_observations WHERE source_kind='events'").get() as { count: number }).count;
    expect(observed).toBeLessThan((sqlite.prepare('SELECT count(*) AS count FROM events').get() as { count: number }).count);
    expect(reader.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally {
    await runtime.stop(); reader?.close(); sqlite.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

it('ACKs durable media receipt before failed rendering, retries unavailable receipt, and recovers a last undelivered completion', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'history-delivery-process-'));
  const archivePath = resolve(dir, 'archive.db'); const historyPath = resolve(dir, 'history.db');
  const sqlite = new Database(archivePath); sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: './drizzle' });
  const sourceSchema = sqlite.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
  const children: ChildProcess[] = [];
  const makeRuntime = () => createHistoryRuntime({
    access: createHistoryAccess({ enabled: true }),
    options: () => ({ archivePath, historyPath, generation: 'media-integration', limits: { rowsPerSecond: 1000 } }),
    logger: useLogger('delivery-integration'), restartMs: 50, shutdownMs: 1000,
    spawn: (entry, args) => { const child = fork(entry, [...args], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child); return child; },
  });
  let runtime = makeRuntime();
  let history: Database.Database | undefined;
  const matches = (needle: string) => (history!.prepare('SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH ?').get(needle) as { n: number }).n;
  try {
    persistEvent(db, { ...message('one'), attachments: [{ type: 'animation', animationHash: 'one' }] });
    persistEvent(db, { ...message('two'), attachments: [{ type: 'animation', animationHash: 'two' }] });
    persistEvent(db, { ...message('three'), attachments: [{ type: 'animation', animationHash: 'three' }] });
    runtime.start(); await waitFor(() => runtime.metrics().ready ? true : undefined);
    history = new Database(historyPath);
    await waitFor(() => {
      const c = history!.prepare('SELECT baseline_complete FROM history_consumers').get() as { baseline_complete: number };
      return c.baseline_complete && !runtime.metrics().awaitingReceipt && !(history!.prepare('SELECT count(*) AS n FROM history_build_inputs').get() as { n: number }).n ? true : undefined;
    });
    history.exec("CREATE TRIGGER deny_receipt BEFORE INSERT ON history_build_inputs BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
    persistImageAltText(db, { imageHash: 'one', altText: 'receiptretryneedle', altTextTokens: 1 });
    const ack = runtime.metrics().acknowledged;
    expect(runtime.notifyMedia('image_alt_texts', 'one')).toBeUndefined();
    // Core persistence completes while History cannot receive; no ACK/FTS wait.
    persistEvent(db, message('continues', 'core continues during receipt failure'));
    expect((sqlite.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n).toBe(4);
    await delay(1200); expect(runtime.metrics().acknowledged).toBe(ack);
    expect(matches('receiptretryneedle')).toBe(0);
    history.exec('DROP TRIGGER deny_receipt');
    await waitFor(() => matches('receiptretryneedle') === 1 ? true : undefined);
    await waitFor(() => !runtime.metrics().awaitingReceipt ? true : undefined);

    history.exec("CREATE TRIGGER deny_render BEFORE UPDATE ON history_items BEGIN SELECT RAISE(ABORT, 'render unavailable'); END");
    persistImageAltText(db, { imageHash: 'two', altText: 'durableackneedle', altTextTokens: 1 });
    const before = runtime.metrics().acknowledged;
    runtime.notifyMedia('image_alt_texts', 'two');
    await waitFor(() => runtime.metrics().acknowledged > before ? true : undefined);
    await waitFor(() => {
      const c = history!.prepare('SELECT pending_seq FROM history_consumers').get() as { pending_seq: number | null };
      return c.pending_seq !== null ? true : undefined;
    });
    expect(matches('durableackneedle')).toBe(0);
    // Kill after durable ACK and failed materialization. The sender has released
    // its frame; only history.db can preserve and resume this responsibility.
    children.at(-1)!.kill('SIGKILL');
    history.exec('DROP TRIGGER deny_render');
    await waitFor(() => matches('durableackneedle') === 1 ? true : undefined);
    await runtime.stop();

    persistImageAltText(db, { imageHash: 'three', altText: 'lastlostcompletion', altTextTokens: 1 });
    // A fresh main runtime has no former delivery memory and sends no completion.
    runtime = makeRuntime(); runtime.start();
    await waitFor(() => matches('lastlostcompletion') === 1 ? true : undefined);
    await waitFor(() => (history!.prepare('SELECT count(*) AS n FROM history_pending_media').get() as { n: number }).n === 0 ? true : undefined);
    expect(sqlite.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(sourceSchema);
    expect(history.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally {
    await runtime.stop(); history?.close(); sqlite.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 45000);
