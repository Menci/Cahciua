import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceBudget, defaultHistoryLimits } from './budget';
import { buildHistoryInput } from './build-input';
import { createHistoryDelivery } from './delivery';
import { createHistoryInbox } from './inbox';
import { createOnlineHistoryBuilder } from './online';
import { restoreMessage } from './restore-message';
import { consumers, savedItems, mediaDependencies } from './schema';
import { createHistoryChanges } from './source-observer';
import { openHistoryStore } from './store';
import { createHistoryArchive } from '../db/history-archive';
import { loadImageAltTextByHash, persistEvent, persistImageAltText, persistTurnResponse } from '../db/persistence';
import * as schema from '../db/schema';
import { computeThumbnailHash, createCachedAltTextHydrator } from '../media/alt-text-cache';
import type { PipelineEvent } from '../projection';
import { createEmptyIC, reduce } from '../projection';
import type { ConversationEntry } from '../unified-api/types';

const dirs: string[] = [];
const clients: Database.Database[] = [];
afterEach(() => { clients.splice(0).forEach(c => { if (c.open) c.close(); }); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const message = (id: string, time = 1000, text = id, chatId = 'A'): Extract<PipelineEvent, { type: 'message' }> => ({
  type: 'message', messageId: id, chatId, receivedAtMs: time, timestampSec: time / 1000, utcOffsetMin: 480,
  content: [{ type: 'text', text }], attachments: [], sender: { id: 'user', displayName: 'User', isBot: false },
});
const fixture = () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'history-online-')); dirs.push(dir);
  const sqlite = new Database(resolve(dir, 'archive.db')); clients.push(sqlite);
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: './drizzle' });
  const reader = new Database(sqlite.name, { readonly: true, fileMustExist: true }); clients.push(reader);
  const readDb = drizzle(reader, { schema });
  const archive = createHistoryArchive(readDb);
  const store = openHistoryStore(resolve(dir, 'history.db')); clients.push(store.sqlite, store.writerLock);
  const hydrateAltText = createCachedAltTextHydrator({ enabled: () => true, lookup: hash => loadImageAltTextByHash(db, hash) });
  const builder = () => createOnlineHistoryBuilder({ db: readDb, archive, store, generation: 'g', archiveIdentity: 'fixture', renderIdentity: 'fixture', hydrateAltText, limits: { rowsPerSecond: 100000 } });
  const items = () => store.db.select().from(savedItems).orderBy(savedItems.key).all().map(row => row.item);
  const inbox = createHistoryInbox(store.sqlite, 'g');
  return { db, readDb, sqlite, reader, archive, store, builder, items, hydrateAltText, inbox };
};
const settle = async (f: ReturnType<typeof fixture>, max = 5000) => {
  const b = f.builder();
  const cycle = b.status().completedSourcePolls;
  for (let i = 0; i < max; i++) {
    await b.step();
    const s = b.status();
    if (s.baselineComplete && s.logLag === 0 && s.buildInputBacklog === 0 && s.completedSourcePolls >= cycle + 2) return s;
  }
  throw new Error('Fixture did not converge');
};
const reference = async (f: ReturnType<typeof fixture>, chatId: string) => {
  const expected = new Map();
  for await (const batch of buildHistoryInput({ archive: f.archive, bounds: f.archive.captureBounds(chatId), pageSize: 2, hydrateAltText: f.hydrateAltText })) for (const change of batch.changes) expected.set(change.item.key, change.item);
  return [...expected.values()].sort((a, b) => a.key.localeCompare(b.key));
};

describe('online history reconciliation', () => {
  it.each(['animation-first', 'thumbnail-first', 'cache-replacement'] as const)('refreshes media descriptions and FTS from source with %s completion', async order => {
    const f = fixture();
    const sharp = (await import('sharp')).default;
    const thumbnailWebp = (await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).webp().toBuffer()).toString('base64');
    const thumbnailKey = computeThumbnailHash(thumbnailWebp);
    const firstKey = order === 'animation-first' ? 'animation' : thumbnailKey;
    persistImageAltText(f.db, { imageHash: firstKey, altText: 'oldneedle', altTextTokens: 1, stickerSetName: 'cached pack' });
    persistEvent(f.db, { ...message('animation'), attachments: [{ type: 'animation', animationHash: 'animation', thumbnailWebp, stickerSetName: 'source pack' }] });
    await settle(f);
    const completedKey = order === 'thumbnail-first' ? 'animation' : thumbnailKey;
    persistImageAltText(f.db, { imageHash: completedKey, altText: 'newneedle', altTextTokens: 1, stickerSetName: 'new cached pack' });
    f.inbox.receive({ kind: 'media', sourceKind: 'image_alt_texts', sourceKey: completedKey });
    await settle(f);
    expect(f.items()).toEqual(await reference(f, 'A'));
    const expectedText = order === 'thumbnail-first' ? 'oldneedle' : 'newneedle';
    expect(f.store.sqlite.prepare('SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH ?').get(expectedText)).toEqual({ n: 1 });
    if (order !== 'thumbnail-first') expect(f.store.sqlite.prepare("SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH 'oldneedle'").get()).toEqual({ n: 0 });
    if (order !== 'cache-replacement') expect(f.builder().status().pendingMedia).toBe(0);
  });

  it('refreshes recursive emoji and reply-at-creation descriptions without replacing the snapshot with later parent content', async () => {
    const f = fixture();
    persistImageAltText(f.db, { imageHash: 'emoji:42', altText: 'oldemoji', altTextTokens: 1, stickerSetName: 'old pack' });
    persistEvent(f.db, { ...message('parent'), content: [{ type: 'bold', children: [{ type: 'custom_emoji', customEmojiId: '42', children: [{ type: 'text', text: 'emoji' }] }] }] });
    persistEvent(f.db, { ...message('reply', 2000), replyToMessageId: 'parent' });
    await settle(f);
    persistEvent(f.db, { ...message('parent', 3000, 'later parent content'), type: 'edit' });
    await settle(f);
    persistImageAltText(f.db, { imageHash: 'emoji:42', altText: 'newemoji', altTextTokens: 1, stickerSetName: 'new pack' });
    f.inbox.receive({ kind: 'media', sourceKind: 'image_alt_texts', sourceKey: 'emoji:42' });
    await settle(f);
    expect(f.items()).toEqual(await reference(f, 'A'));
    expect(f.store.sqlite.prepare("SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH 'newemoji'").get()).toEqual({ n: 1 });
    expect(f.store.sqlite.prepare("SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH 'oldemoji'").get()).toEqual({ n: 0 });
  });

  it('preserves source descriptions and sticker metadata when a cache completes', async () => {
    const f = fixture();
    persistEvent(f.db, { ...message('authoritative'), attachments: [{ type: 'sticker', animationHash: 'source-sticker', altText: 'source description', stickerSetName: 'source pack' }] });
    await settle(f);
    persistImageAltText(f.db, { imageHash: 'source-sticker', altText: 'cached description', altTextTokens: 1, stickerSetName: 'cached pack' });
    f.inbox.receive({ kind: 'media', sourceKind: 'image_alt_texts', sourceKey: 'source-sticker' });
    await settle(f);
    expect(f.items()).toEqual(await reference(f, 'A'));
    const item = f.items()[0];
    expect(item?.kind === 'message' && item.metadata.attachments).toMatchObject([{ altText: 'source description', stickerSetName: 'source pack' }]);
  });

  it('migrates already-completed stale media output into durable targeted repair without resetting consumption', async () => {
    const f = fixture();
    const sharp = (await import('sharp')).default;
    const thumbnailWebp = (await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).webp().toBuffer()).toString('base64');
    persistImageAltText(f.db, { imageHash: 'animation', altText: 'staleanimation', altTextTokens: 1 });
    persistEvent(f.db, { ...message('animation'), attachments: [{ type: 'animation', animationHash: 'animation', thumbnailWebp }] });
    await settle(f);
    const oldState = f.store.sqlite.prepare('SELECT state_json FROM history_message_states').get() as { state_json: string };
    const oldItem = f.store.sqlite.prepare('SELECT item_json,search_text FROM history_items').get() as { item_json: string; search_text: string };
    const key = computeThumbnailHash(thumbnailWebp);
    persistImageAltText(f.db, { imageHash: key, altText: 'currentthumbnail', altTextTokens: 1 });
    f.inbox.receive({ kind: 'media', sourceKind: 'image_alt_texts', sourceKey: key });
    await settle(f);
    expect(f.builder().status().pendingMedia).toBe(0);
    // Simulate the old release's completed task with stale persisted output.
    f.store.sqlite.prepare('UPDATE history_message_states SET state_json=?').run(oldState.state_json);
    f.store.sqlite.prepare('UPDATE history_items SET item_json=?,search_text=?').run(oldItem.item_json, oldItem.search_text);
    const cursor = f.builder().status().consumeSeq;
    const journal = JSON.parse(readFileSync(resolve('history-drizzle/meta/_journal.json'), 'utf8')) as { entries: { when: number; tag: string }[] };
    f.store.sqlite.exec('ALTER TABLE history_build_inputs DROP COLUMN after_key; ALTER TABLE history_build_inputs DROP COLUMN upper_key');
    f.store.sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at>=?').run(journal.entries.find(entry => entry.tag === '0005_refresh_media_descriptions')!.when);
    migrate(f.store.db, { migrationsFolder: './history-drizzle' });
    const changes = createHistoryChanges(f.store.sqlite, 'g');
    const repairUpper = changes.watermark();
    expect(repairUpper).toBeGreaterThan(cursor);
    expect(f.builder().status().consumeSeq).toBe(cursor);
    migrate(f.store.db, { migrationsFolder: './history-drizzle' });
    expect(changes.watermark()).toBe(repairUpper);
    // Reconstruct the builder to consume persisted migration work after restart.
    await settle(f);
    expect(f.items()).toEqual(await reference(f, 'A'));
    expect(f.builder().status().consumeSeq).toBeGreaterThanOrEqual(repairUpper);
    expect(f.builder().status().logLag).toBe(0);
    expect(f.store.sqlite.prepare("SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH 'currentthumbnail'").get()).toEqual({ n: 1 });
    expect(f.store.sqlite.prepare("SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH 'staleanimation'").get()).toEqual({ n: 0 });
  });

  it('applies appended edit overrides to persisted state without replaying the old edit bodies or blocking other chats', async () => {
    const f = fixture();
    persistEvent(f.db, message('edited', 1000, 'original'));
    for (let i = 1; i <= 300; i++) persistEvent(f.db, { ...message('edited', 1000 + i, `edit ${i}`), type: 'edit' });
    persistEvent(f.db, message('B-old', 1000, 'other chat', 'B'));
    await settle(f);
    const oldUpperId = f.archive.captureBounds('A').upperIds.events;
    const reads = vi.spyOn(f.archive, 'readEvents');
    for (let i = 301; i <= 600; i++) persistEvent(f.db, { ...message('edited', 1000 + i, `edit ${i}`), type: 'edit' });
    persistEvent(f.db, message('B-new', 2000, 'another chat advances', 'B'));
    await settle(f);
    expect(reads.mock.calls.every(([request]) => request.exactId === undefined || request.exactId > oldUpperId)).toBe(true);
    reads.mockRestore();
    expect(f.items().filter(i => i.chatId === 'A')).toEqual(await reference(f, 'A'));
    expect(f.items().filter(i => i.chatId === 'B')).toEqual(await reference(f, 'B'));
  });

  it('preserves an existing reply snapshot during its own edit without reading the parent or original message again', async () => {
    const f = fixture();
    persistEvent(f.db, message('parent', 1000, 'parent at reply'));
    persistEvent(f.db, { ...message('reply', 2000, 'original reply'), replyToMessageId: 'parent' });
    await settle(f);
    const oldUpperId = f.archive.captureBounds('A').upperIds.events;
    const reads = vi.spyOn(f.archive, 'readEvents');
    persistEvent(f.db, { ...message('reply', 3000, 'edited reply'), type: 'edit' });
    await settle(f);
    expect(reads.mock.calls.every(([request]) => request.exactId === undefined || request.exactId > oldUpperId)).toBe(true);
    reads.mockRestore();
    expect(f.items()).toEqual(await reference(f, 'A'));
  });

  it('recovers only effective overrides for replies into a heavily edited past, preserving deletion and original metadata', async () => {
    const f = fixture();
    persistEvent(f.db, message('parent', 1000, 'original parent'));
    for (let i = 1; i <= 400; i++) persistEvent(f.db, { ...message('parent', 1000 + i, `parent edit ${i}`), type: 'edit' });
    await settle(f);
    persistEvent(f.db, { ...message('reply', 1250.5, 'reply from the past'), replyToMessageId: 'parent' });
    persistEvent(f.db, { type: 'delete', chatId: 'A', messageIds: ['parent'], receivedAtMs: 1500, timestampSec: 1.5, utcOffsetMin: 480 });
    persistEvent(f.db, { ...message('parent', 1600, 'latest parent'), type: 'edit' });
    await settle(f);
    expect(f.items()).toEqual(await reference(f, 'A'));
    const parent = f.items().find(i => i.kind === 'message' && i.metadata.messageId === 'parent');
    const reply = f.items().find(i => i.kind === 'message' && i.metadata.messageId === 'reply');
    expect(parent?.kind === 'message' && parent.metadata.deleted).toBe(true);
    expect(reply?.kind === 'message' && reply.transcript.reply?.text).toBe('parent edit 250');
  });

  it('restores a long reply thread from the direct parent without walking all ancestors', async () => {
    const f = fixture();
    let ic = createEmptyIC('A');
    f.sqlite.transaction(() => {
      for (let i = 1; i <= 300; i++) {
        const event = { ...message(String(i), i * 1000, `full body ${i}`), replyToMessageId: i > 1 ? String(i - 1) : undefined };
        persistEvent(f.db, event);
        ic = reduce(ic, event);
      }
    })();
    await settle(f);
    const budget = createWorkspaceBudget(defaultHistoryLimits);
    const restored = restoreMessage({ db: f.readDb, store: f.store, generation: 'g', archive: f.archive, chatId: 'A', messageId: '300', maxSourceBytes: defaultHistoryLimits.maxSourceBytes, budget });
    expect(restored?.node).toEqual(ic.nodes.at(-1));
    expect(budget.entries).toBeLessThanOrEqual(6);
  });

  it('keeps synchronization state exclusively in history.db and observes only committed source writes', async () => {
    const f = fixture(); const changes = createHistoryChanges(f.store.sqlite, 'g');
    const sourceSchema = f.sqlite.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    expect(f.reader.readonly).toBe(true);
    expect(() => f.db.transaction(() => { persistEvent(f.db, message('1')); throw new Error('rollback'); })).toThrow('rollback');
    await settle(f);
    expect(changes.watermark()).toBe(0);
    persistEvent(f.db, message('1'));
    expect(changes.watermark()).toBe(0);
    await settle(f);
    expect(changes.next(0, defaultHistoryLimits.maxSourceBytes)?.targetIds).toEqual(['1']);
    expect(f.items()).toEqual(await reference(f, 'A'));
    expect(f.sqlite.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(sourceSchema);
    expect(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'history_%'").all()).toEqual([]);
  });

  it('commits observation, queue and scan checkpoint atomically across restart', async () => {
    const f = fixture();
    const builder = f.builder();
    persistEvent(f.db, message('new'));
    const beforeSeq = createHistoryChanges(f.store.sqlite, 'g').watermark();
    f.store.sqlite.exec("CREATE TRIGGER fail_scan BEFORE UPDATE ON history_source_scans WHEN json_extract(new.state_json, '$.afterIds.events') > 0 BEGIN SELECT RAISE(ABORT, 'scan failure'); END");
    await expect(builder.step()).rejects.toThrow('scan failure');
    const scan = f.store.sqlite.prepare('SELECT state_json AS value FROM history_source_scans').get() as { value: string };
    expect(JSON.parse(scan.value).afterIds.events).toBe(0);
    expect(createHistoryChanges(f.store.sqlite, 'g').watermark()).toBe(beforeSeq);
    expect(f.store.sqlite.prepare("SELECT source_key FROM history_source_observations WHERE source_kind='events'").all()).toEqual([]);
    f.store.sqlite.exec('DROP TRIGGER fail_scan');
    await settle(f);
    expect(f.items()).toEqual(await reference(f, 'A'));
  });

  it('fixes reconciliation watermark, discovers archive-only and new chats, preserves replies and does not miss backdated rows or appended edits', async () => {
    const f = fixture();
    persistEvent(f.db, message('1', 1000, 'original'));
    persistEvent(f.db, { ...message('2', 2000, 'reply'), replyToMessageId: '1' });
    persistEvent(f.db, message('B1', 1000, 'B', 'B'));
    f.db.insert(schema.compactions).values({ chatId: 'summary-only', oldCursorMs: 0, newCursorMs: 1000, summary: 'summaryneedle', createdAt: 4000 }).run();
    const b = f.builder();
    const s0 = b.status().baselineSeq;
    await b.step();
    persistEvent(f.db, { ...message('1', 3000, 'edited'), type: 'edit' });
    persistEvent(f.db, message('early', 500, 'backdated'));
    persistEvent(f.db, message('new', 1000, 'new chat', 'new-chat'));
    await settle(f);
    expect(b.status().baselineSeq).toBe(s0);
    expect(b.status().reconcileSeq).not.toBeNull();
    expect(f.items().filter(i => i.chatId === 'A')).toEqual(await reference(f, 'A'));
    expect(f.items().filter(i => i.chatId === 'B')).toEqual(await reference(f, 'B'));
    expect(f.items().filter(i => i.chatId === 'new-chat')).toEqual(await reference(f, 'new-chat'));
    expect(f.items().filter(i => i.kind === 'summary')).toHaveLength(1);
    const s1 = b.status().reconcileSeq;
    persistEvent(f.db, { type: 'delete', chatId: 'A', messageIds: ['1'], receivedAtMs: 4000, timestampSec: 4, utcOffsetMin: 480 });
    await settle(f);
    expect(b.status().reconcileSeq).toBe(s1);
    expect(f.items().filter(i => i.chatId === 'A')).toEqual(await reference(f, 'A'));
    expect(f.store.sqlite.prepare("SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH 'summaryneedle'").get()).toEqual({ n: 1 });
  });

  it('reconciles shared descriptions from durable dependencies, echo/backfill and late explicit task starts', async () => {
    const f = fixture();
    persistEvent(f.db, { ...message('emoji'), content: [{ type: 'custom_emoji', customEmojiId: '7', children: [{ type: 'text', text: 'x' }] }] });
    persistEvent(f.db, { ...message('self', 2000, 'synthetic'), isSelfSent: true });
    await settle(f);
    expect(f.store.db.select().from(mediaDependencies).all().map(d => d.cacheKey)).toContain('emoji:7');
    persistImageAltText(f.db, { imageHash: 'emoji:7', altText: 'descriptionneedle', altTextTokens: 1 });
    f.inbox.receive({ kind: 'media', sourceKind: 'image_alt_texts', sourceKey: 'emoji:7' });
    persistEvent(f.db, message('self', 3000, 'authoritative'));
    persistEvent(f.db, { type: 'runtime', chatId: 'A', receivedAtMs: 4000, timestampSec: 4, utcOffsetMin: 480, kind: 'task_completed', taskId: 7, taskType: 'bash', finalSummary: 'completionneedle', hasFullOutput: true });
    await settle(f);
    await persistTurnResponse(f.db, 'A', {
      entries: [
        { kind: 'message', role: 'assistant', reasoning: undefined, parts: [{ kind: 'toolCall', name: 'bash', callId: 'call', args: '{}' }] },
        { kind: 'toolResult', callId: 'call', payload: '{"background_task_id":7}', requiresFollowUp: false },
      ], requestedAtMs: 1000, modelName: 'fixture', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    await settle(f);
    expect(f.items()).toEqual(await reference(f, 'A'));
    expect(f.store.sqlite.prepare("SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH 'descriptionneedle'").get()).toEqual({ n: 1 });
    expect(f.store.sqlite.prepare("SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH 'completionneedle'").get()).toEqual({ n: 1 });
  });

  it('rolls back a consume batch and resumes its durable task without skipping the continuous prefix', async () => {
    const f = fixture(); persistEvent(f.db, message('1')); await settle(f);
    persistEvent(f.db, { ...message('1', 2000, 'new'), type: 'edit' });
    const before = f.store.db.select().from(consumers).get()!.consumeSeq;
    f.store.sqlite.exec("CREATE TRIGGER fail_history BEFORE UPDATE ON history_items BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    let failed = false;
    const b = f.builder();
    for (let i = 0; i < 30 && !failed; i++) {
      try { await b.step(); } catch (error) { expect(String(error)).toContain('History consume failed'); failed = true; }
    }
    expect(failed).toBe(true);
    expect(f.store.db.select().from(consumers).get()!.consumeSeq).toBe(before);
    f.store.sqlite.exec('DROP TRIGGER fail_history');
    await settle(f);
    expect(f.items()).toEqual(await reference(f, 'A'));
  });
});

it('retains a budget failure task/prefix and can resume the same generation with a larger budget', async () => {
  const f = fixture(); persistEvent(f.db, message('1')); await settle(f);
  persistEvent(f.db, { ...message('1', 2000, 'x'.repeat(10000)), type: 'edit' });
  const options = { db: f.readDb, archive: f.archive, store: f.store, generation: 'g', archiveIdentity: 'fixture', renderIdentity: 'fixture' };
  const before = f.builder().status().consumeSeq;
  const limited = createOnlineHistoryBuilder({ ...options, limits: { maxSourceBytes: 4096, rowsPerSecond: 100000 } });
  let failed = false;
  for (let i = 0; i < 30 && !failed; i++) {
    try { await limited.step(); } catch (error) { expect(String(error)).toContain('byte budget'); failed = true; }
  }
  expect(failed).toBe(true);
  expect(limited.status().consumeSeq).toBe(before);
  await settle(f);
  expect(f.items()).toEqual(await reference(f, 'A'));
  expect(() => createOnlineHistoryBuilder({ ...options, archiveIdentity: 'another archive' })).toThrow('identity/version mismatch');
});

it('enforces one OS-locked writer while allowing read-only status connections', () => {
  const f = fixture();
  expect(() => openHistoryStore(f.store.sqlite.name)).toThrow('writer already active');
  const alias = resolve(f.store.sqlite.name, '../alias.db');
  symlinkSync(f.store.sqlite.name, alias);
  expect(() => openHistoryStore(alias)).toThrow('writer already active');
  const hardLink = resolve(f.store.sqlite.name, '../hard-link.db');
  linkSync(f.store.sqlite.name, hardLink);
  expect(() => openHistoryStore(hardLink)).toThrow('hard-link aliases');
  const reader = new Database(f.store.sqlite.name, { readonly: true });
  try { expect(reader.pragma('integrity_check', { simple: true })).toBe('ok'); } finally { reader.close(); }
});

it('revalidates completion ambiguity for appended task starts and completion events', async () => {
  const f = fixture(); persistEvent(f.db, message('1')); await settle(f);
  const entries = (taskId: number): ConversationEntry[] => [
    { kind: 'message', role: 'assistant', reasoning: undefined, parts: [{ kind: 'toolCall', name: 'bash', callId: 'c', args: '{}' }] },
    { kind: 'toolResult', callId: 'c', payload: JSON.stringify({ background_task_id: taskId }), requiresFollowUp: false },
  ];
  const turn = async (taskId: number) => await persistTurnResponse(f.db, 'A', { entries: entries(taskId), requestedAtMs: 1000, modelName: 'fixture', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
  await turn(7);
  persistEvent(f.db, { type: 'runtime', chatId: 'A', kind: 'task_completed', taskId: 7, taskType: 'bash', finalSummary: 'complete', hasFullOutput: true, receivedAtMs: 3000, timestampSec: 3, utcOffsetMin: 480 });
  await settle(f); expect(f.items()).toEqual(await reference(f, 'A'));
  await turn(7); await settle(f); expect(f.items()).toEqual(await reference(f, 'A'));
  await turn(8);
  persistEvent(f.db, { type: 'runtime', chatId: 'A', kind: 'task_completed', taskId: 8, taskType: 'bash', finalSummary: 'another completion', hasFullOutput: true, receivedAtMs: 4000, timestampSec: 4, utcOffsetMin: 480 });
  await settle(f); expect(f.items()).toEqual(await reference(f, 'A'));
});

it('refreshes an old attachment backfill and shared cache across chats without a new media call', async () => {
  const f = fixture();
  persistEvent(f.db, { ...message('anim'), attachments: [{ type: 'animation', fileName: 'clip.gif' }] });
  persistEvent(f.db, { ...message('animB', 1000, 'B', 'B'), attachments: [{ type: 'animation', animationHash: 'shared' }] });
  await settle(f);
  f.db.update(schema.events).set({ attachments: [{ type: 'animation', animationHash: 'shared', fileName: 'clip.gif' }] }).where(eq(schema.events.id, 1)).run();
  // Recovery covers the last completion lost with the producer process.
  f.inbox.receive({ kind: 'recover' });
  await settle(f);
  expect(f.builder().status().pendingMedia).toBe(1);
  persistImageAltText(f.db, { imageHash: 'shared', altText: 'descriptionneedle', altTextTokens: 1 });
  f.inbox.receive({ kind: 'media', sourceKind: 'image_alt_texts', sourceKey: 'shared' });
  await settle(f);
  expect(f.items().filter(i => i.chatId === 'A')).toEqual(await reference(f, 'A'));
  expect(f.items().filter(i => i.chatId === 'B')).toEqual(await reference(f, 'B'));
  expect(f.store.sqlite.prepare("SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH 'descriptionneedle'").get()).toEqual({ n: 2 });
});

it('never rereads committed source rows on idle polls or unrelated appends', async () => {
  const f = fixture();
  for (let i = 0; i < 50; i++) persistEvent(f.db, message(String(i), 1000 + i));
  await settle(f);
  const readEvents = vi.spyOn(f.archive, 'readEvents');
  const readTurns = vi.spyOn(f.archive, 'readTurns');
  const readCompactions = vi.spyOn(f.archive, 'readCompactions');
  for (let i = 0; i < 100; i++) await f.builder().step();
  expect(readEvents).not.toHaveBeenCalled();
  expect(readTurns).not.toHaveBeenCalled();
  expect(readCompactions).not.toHaveBeenCalled();
  persistEvent(f.db, message('new', 10));
  await settle(f);
  expect(readEvents.mock.calls.length).toBeGreaterThan(0);
  expect(readEvents.mock.calls.every(([request]) => request.exactId === 51)).toBe(true);
  expect(readTurns).not.toHaveBeenCalled();
  expect(readCompactions).not.toHaveBeenCalled();
});

it('retains failed media scheduling atomically, retries its durable input, and never polls pending normally', async () => {
  const f = fixture();
  persistEvent(f.db, { ...message('animation'), attachments: [{ type: 'animation' }] });
  await settle(f);
  const before = f.builder().status().sourceHighwaterIds!.events;
  const reads = vi.spyOn(f.archive, 'readEvents');
  const b = f.builder();
  for (let i = 0; i < 100; i++) await b.step();
  expect(reads).not.toHaveBeenCalled();
  persistEvent(f.db, message('new')); await settle(f);
  expect(b.status().sourceHighwaterIds!.events).toBe(before + 1);
  expect(b.status().pendingMedia).toBe(1);
  f.db.update(schema.events).set({ attachments: [{ type: 'animation', animationHash: 'ready' }] }).where(eq(schema.events.id, 1)).run();
  persistImageAltText(f.db, { imageHash: 'ready', altText: 'ready description', altTextTokens: 1 });
  f.inbox.receive({ kind: 'media', sourceKind: 'events', sourceKey: '1' });
  f.store.sqlite.exec("CREATE TRIGGER fail_media BEFORE UPDATE OF scheduled_seq ON history_pending_media BEGIN SELECT RAISE(ABORT, 'media failure'); END");
  const seq = createHistoryChanges(f.store.sqlite, 'g').watermark();
  let failed = false;
  for (let i = 0; i < 4; i++) {
    try { await b.step(); } catch (error) { expect(String(error)).toContain('media failure'); failed = true; break; }
  }
  expect(failed).toBe(true);
  expect(createHistoryChanges(f.store.sqlite, 'g').watermark()).toBe(seq);
  expect(b.status().pendingMedia).toBe(1);
  expect(b.status().buildInputBacklog).toBe(1);
  f.store.sqlite.exec('DROP TRIGGER fail_media'); await settle(f);
  expect(b.status().pendingMedia).toBe(0);
  expect(f.items()).toEqual(await reference(f, 'A'));
  reads.mockClear(); for (let i = 0; i < 100; i++) await b.step();
  expect(reads).not.toHaveBeenCalled();
});

it('covers completion between source read and pending registration even when its notice arrived first', async () => {
  const f = fixture();
  persistEvent(f.db, { ...message('racing'), attachments: [{ type: 'animation' }] });
  const read = f.archive.readEvents.bind(f.archive);
  let raced = false;
  vi.spyOn(f.archive, 'readEvents').mockImplementation(request => {
    const result = read(request);
    if (!raced && result.rows[0]?.ref.id === 1) {
      raced = true;
      f.db.update(schema.events).set({ attachments: [{ type: 'animation', animationHash: 'race' }] }).where(eq(schema.events.id, 1)).run();
      persistImageAltText(f.db, { imageHash: 'race', altText: 'racedescription', altTextTokens: 1 });
      f.inbox.receive({ kind: 'media', sourceKind: 'events', sourceKey: '1' });
    }
    return result;
  });
  await settle(f);
  expect(raced).toBe(true);
  expect(f.builder().status().pendingMedia).toBe(0);
  expect(f.items()).toEqual(await reference(f, 'A'));
});

it('persists finite pending recovery progress and resumes it after receiver restart without scanning complete rows', async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) persistEvent(f.db, { ...message(`missing-${i}`), attachments: [{ type: 'animation', animationHash: `media-${i}` }] });
  persistEvent(f.db, message('complete')); await settle(f);
  for (let i = 0; i < 12; i++) persistImageAltText(f.db, { imageHash: `media-${i}`, altText: `offlinecompletion ${i}`, altTextTokens: 1 });
  f.inbox.receive({ kind: 'recover' });
  const b = f.builder();
  for (let i = 0; i < 4; i++) await b.step();
  const progress = f.store.sqlite.prepare("SELECT after_id, upper_id FROM history_build_inputs WHERE source_kind = 'pending'").get() as { after_id: number; upper_id: number };
  expect(progress.after_id).toBeGreaterThan(0); expect(progress.upper_id).toBeGreaterThan(progress.after_id);
  // A new builder uses the persisted cursor, without resetting it or replaying
  // completed archive prefixes. Worker reconnect may explicitly request a new pass.
  expect(f.builder().status().mediaRecoveryActive).toBe(true);
  await settle(f);
  expect(f.builder().status()).toMatchObject({ pendingMedia: 0, mediaRecoveryActive: false });
  expect(f.items()).toEqual(await reference(f, 'A'));
});

it('pauses source discovery at durable backlog pressure and resumes after construction recovers', async () => {
  const f = fixture(); persistEvent(f.db, message('seed')); await settle(f);
  for (let i = 0; i < 350; i++) persistEvent(f.db, message(`queued-${i}`));
  f.store.sqlite.exec("CREATE TRIGGER fail_render BEFORE INSERT ON history_items BEGIN SELECT RAISE(ABORT, 'output failure'); END");
  const b = f.builder();
  for (let i = 0; i < 500; i++) { try { await b.step(); } catch { /* Intentionally retained failed output task. */ } }
  const pressure = b.status();
  expect(pressure.logLag).toBe(256);
  expect(pressure.sourceHighwaterIds!.events).toBeLessThan(351);
  for (let i = 0; i < 20; i++) await expect(b.step()).rejects.toThrow('History consume failed');
  expect(b.status().sourceHighwaterIds).toEqual(pressure.sourceHighwaterIds);
  f.store.sqlite.exec('DROP TRIGGER fail_render'); await settle(f);
  expect(f.items()).toHaveLength(351);
  expect(b.status().sourceHighwaterIds!.events).toBe(351);
}, 30000);

it('continues source discovery and other chats after a 257-target delete', async () => {
  const f = fixture();
  const ids = Array.from({ length: 257 }, (_, i) => String(i));
  for (const id of ids) persistEvent(f.db, message(id));
  persistEvent(f.db, message('other-before', 1000, 'before', 'B'));
  await settle(f);
  persistEvent(f.db, { type: 'delete', chatId: 'A', messageIds: ids, receivedAtMs: 2000, timestampSec: 2, utcOffsetMin: 480 });
  persistEvent(f.db, message('other-after', 3000, 'after', 'B'));
  const errors: string[] = [];
  for (let restart = 0; restart < 3; restart++) {
    const b = f.builder();
    for (let i = 0; i < 30; i++) {
      try { await b.step(); } catch (error) { errors.push(String(error)); break; }
    }
  }
  expect(errors).toEqual([]);
  await settle(f);
  expect(f.items().filter(item => item.chatId === 'A')).toEqual(await reference(f, 'A'));
  expect(f.items().some(item => item.kind === 'message' && item.metadata.messageId === 'other-after')).toBe(true);
});

it('recovers an overwritten completed media key after delivery overflow loses its notice', async () => {
  const f = fixture();
  persistEvent(f.db, { ...message('animation'), attachments: [{ type: 'animation', animationHash: 'shared' }] });
  await settle(f);
  persistImageAltText(f.db, { imageHash: 'shared', altText: 'oldneedle', altTextTokens: 1 });
  f.inbox.receive({ kind: 'media', sourceKind: 'image_alt_texts', sourceKey: 'shared' });
  await settle(f);
  expect(f.builder().status().pendingMedia).toBe(0);
  persistImageAltText(f.db, { imageHash: 'shared', altText: 'newneedle', altTextTokens: 1 });
  const delivery: ReturnType<typeof createHistoryDelivery> = createHistoryDelivery({
    maxItems: 1, onError: error => { throw error; }, send: (frame, callback) => {
      f.inbox.receive(frame.input);
      callback(null);
      queueMicrotask(() => delivery.acknowledge(frame.id));
    },
  });
  try {
    delivery.offer({ kind: 'media', sourceKind: 'image_alt_texts', sourceKey: 'shared' });
    delivery.offer({ kind: 'media', sourceKind: 'image_alt_texts', sourceKey: 'overflow' });
    expect(delivery.metrics()).toMatchObject({ notificationItems: 0, recoveryRequested: true });
    delivery.connect();
    await new Promise(resolve => setTimeout(resolve, 0));
    await settle(f);
    const expected = await reference(f, 'A');
    expect(f.items()).toEqual(expected);
  } finally { delivery.stop(); }
});

it('bootstraps a large delete without loading all target states into one workspace', async () => {
  const f = fixture();
  const ids = Array.from({ length: 300 }, (_, i) => String(i));
  for (const id of ids) persistEvent(f.db, message(id));
  persistEvent(f.db, { type: 'delete', chatId: 'A', messageIds: [...ids, 'unknown'], receivedAtMs: 2000, timestampSec: 2, utcOffsetMin: 480 });
  const status = await settle(f);
  expect(f.items()).toEqual(await reference(f, 'A'));
  expect(status.peakStateEntries).toBeLessThanOrEqual(256);
});

it('resumes partially committed bootstrap deletion after failure and store restart', async () => {
  const f = fixture();
  const ids = Array.from({ length: 260 }, (_, i) => String(i));
  for (const id of ids) persistEvent(f.db, message(id));
  persistEvent(f.db, { type: 'delete', chatId: 'A', messageIds: ids, receivedAtMs: 2000, timestampSec: 2, utcOffsetMin: 480 });
  const deleted = f.sqlite.prepare('SELECT max(id) AS id FROM events').get() as { id: number };
  const b = f.builder();
  const applied = () => (f.store.sqlite.prepare('SELECT count(*) AS n FROM history_message_revisions WHERE event_id = ?').get(deleted.id) as { n: number }).n;
  for (let i = 0; i < 2000 && applied() < 7; i++) await b.step();
  expect(applied()).toBe(7);
  const checkpoint = f.store.checkpoint('g', 'A', 'events');
  expect(checkpoint.after?.id).toBeLessThan(deleted.id);
  f.store.sqlite.exec("CREATE TRIGGER fail_delete BEFORE INSERT ON history_items BEGIN SELECT RAISE(ABORT, 'output failure'); END");
  await expect(b.step()).rejects.toThrow('History bootstrap failed');
  expect(applied()).toBe(7);
  expect(f.store.checkpoint('g', 'A', 'events')).toEqual(checkpoint);
  f.store.sqlite.exec('DROP TRIGGER fail_delete');
  const path = f.store.sqlite.name; f.store.close();
  const store = openHistoryStore(path); clients.push(store.sqlite, store.writerLock);
  const restarted = {
    ...f, store,
    builder: () => createOnlineHistoryBuilder({ db: f.readDb, archive: f.archive, store, generation: 'g', archiveIdentity: 'fixture', renderIdentity: 'fixture', hydrateAltText: f.hydrateAltText, limits: { rowsPerSecond: 100000 } }),
    items: () => store.db.select().from(savedItems).orderBy(savedItems.key).all().map(row => row.item),
  };
  await settle(restarted);
  expect(restarted.items()).toEqual(await reference(restarted, 'A'));
  expect((store.sqlite.prepare('SELECT count(*) AS n FROM history_message_revisions WHERE event_id = ?').get(deleted.id) as { n: number }).n).toBe(260);
}, 30000);

it('persists a finite completed-cache recovery cursor and resumes after receiver restart', async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) {
    persistImageAltText(f.db, { imageHash: `complete-${i}`, altText: `oldcache ${i}`, altTextTokens: 1 });
    persistEvent(f.db, { ...message(`media-${i}`), attachments: [{ type: 'animation', animationHash: `complete-${i}` }] });
  }
  await settle(f);
  expect(f.builder().status().pendingMedia).toBe(0);
  for (let i = 0; i < 12; i++) persistImageAltText(f.db, { imageHash: `complete-${i}`, altText: `freshcache ${i}`, altTextTokens: 1 });
  f.inbox.receive({ kind: 'recover' });
  const b = f.builder();
  const progress = () => f.store.sqlite.prepare("SELECT after_key, upper_key FROM history_build_inputs WHERE source_kind = 'dependencies'").get() as { after_key: string | null; upper_key: string | null };
  for (let i = 0; i < 40 && !progress()?.after_key; i++) await b.step();
  expect(progress()).toMatchObject({ after_key: 'complete-0', upper_key: 'complete-9' });
  expect(f.builder().status().mediaRecoveryActive).toBe(true);
  await settle(f);
  expect(f.items()).toEqual(await reference(f, 'A'));
  expect(f.store.sqlite.prepare("SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH 'oldcache'").get()).toEqual({ n: 0 });
  expect(f.store.sqlite.prepare("SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH 'freshcache'").get()).toEqual({ n: 12 });
  const watermark = createHistoryChanges(f.store.sqlite, 'g').watermark();
  f.inbox.receive({ kind: 'recover' }); await settle(f);
  expect(createHistoryChanges(f.store.sqlite, 'g').watermark()).toBe(watermark);
});

it('rolls back target expansion and resumes a large delete from its saved ordinal', async () => {
  const f = fixture();
  const ids = Array.from({ length: 257 }, (_, i) => String(i));
  for (const id of ids) persistEvent(f.db, message(id));
  await settle(f);
  persistEvent(f.db, { type: 'delete', chatId: 'A', messageIds: ids, receivedAtMs: 2000, timestampSec: 2, utcOffsetMin: 480 });
  f.store.sqlite.exec("CREATE TRIGGER fail_fanout BEFORE INSERT ON history_consume_tasks WHEN NEW.kind = 'replies' BEGIN SELECT RAISE(ABORT, 'fanout failure'); END");
  const b = f.builder();
  let failed = false;
  for (let i = 0; i < 30 && !failed; i++) { try { await b.step(); } catch (error) { expect(String(error)).toContain('kind=targets'); failed = true; } }
  expect(failed).toBe(true);
  expect(f.store.sqlite.prepare("SELECT source_key,done FROM history_consume_tasks WHERE kind='targets'").get()).toEqual({ source_key: '0', done: 0 });
  expect(f.store.sqlite.prepare("SELECT count(*) AS n FROM history_consume_tasks WHERE kind IN ('message','replies')").get()).toEqual({ n: 0 });
  const cursor = b.status().consumeSeq;
  f.store.sqlite.exec('DROP TRIGGER fail_fanout');
  await settle(f);
  expect(f.builder().status().consumeSeq).toBeGreaterThan(cursor);
  expect(f.items()).toEqual(await reference(f, 'A'));
}, 30000);
