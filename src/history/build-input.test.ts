import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import { buildHistoryInput, compareHistoryOrder } from './index';
import type { HistoryBatch, HistoryItem, HistoryMessage, HistoryNotice, HistoryResult, HistoryTool } from './types';
import { codec } from '../db/codec';
import { createHistoryArchive } from '../db/history-archive';
import type { HistoryArchive, HistoryArchiveBounds } from '../db/history-archive';
import { loadEvents, loadImageAltTextByHash, persistEvent, persistTurnResponse } from '../db/persistence';
import * as schema from '../db/schema';
import { computeThumbnailHash, createCachedAltTextHydrator } from '../media/alt-text-cache';
import { createEmptyIC, reduce } from '../projection';
import type { PipelineEvent } from '../projection';
import { createRenderer } from '../rendering';
import type { ConversationEntry } from '../unified-api/types';

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
const fixture = () => {
  const sqlite = new Database(':memory:');
  opened.push(sqlite);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return { db, archive: createHistoryArchive(db) };
};
const message = (messageId: string, receivedAtMs: number, text = messageId, chatId = 'chat'): Extract<PipelineEvent, { type: 'message' }> => ({
  type: 'message', chatId, messageId, receivedAtMs, timestampSec: receivedAtMs / 1000, utcOffsetMin: 0,
  sender: { id: 'user', displayName: 'User', isBot: false }, content: [{ type: 'text', text }], attachments: [],
});
const turn = (entries: ConversationEntry[], requestedAtMs = 1000) => ({
  entries, requestedAtMs, modelName: 'test', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
});
const calls = (name = 'work', callId = 'reused'): ConversationEntry[] => [{
  kind: 'message', role: 'assistant', reasoning: undefined, parts: [{ kind: 'toolCall', name, callId, args: '{"command":"full command"}' }],
}, { kind: 'toolResult', callId, payload: 'full result', requiresFollowUp: false }];
// Minimal saved-item writer: a real writer can persist the same upserts and
// source progress together. The builder never hands it an all-history array.
const consume = async (archive: HistoryArchive, bounds: HistoryArchiveBounds, pageSize = 1, hydrateAltText?: (event: PipelineEvent) => void) => {
  const saved = new Map<string, HistoryItem>();
  const batches: HistoryBatch[] = [];
  const notices: HistoryNotice[] = [];
  for await (const batch of buildHistoryInput({ archive, bounds, pageSize, hydrateAltText })) {
    batches.push(batch);
    notices.push(...batch.notices);
    for (const change of batch.changes) saved.set(change.item.key, change.item);
  }
  return { saved, batches, notices, items: [...saved.values()].sort((a, b) => compareHistoryOrder(a.order, b.order)) };
};
const summaries = (count: number, chatId = 'chat') => Array.from({ length: count }, (_, i) => ({
  chatId, oldCursorMs: i * 1000, newCursorMs: (i + 1) * 1000, summary: `summary ${i}`, createdAt: 1000,
}));

describe('historical archive input', () => {
  it('isolates all three sources and keyset-pages tied timestamps within captured bounds', async () => {
    const { db, archive } = fixture();
    for (const chatId of ['chat', 'other']) {
      for (const [index, at] of [2000, 1000, 1000, 1000].entries()) persistEvent(db, message(String(index), at, chatId, chatId));
      for (let i = 0; i < 3; i++) await persistTurnResponse(db, chatId, turn(calls()));
      db.insert(schema.compactions).values(summaries(3, chatId)).run();
    }
    const bounds = archive.captureBounds('chat');
    // New backdated rows would fall between existing keysets without ID fences.
    persistEvent(db, message('outside', 500));
    await persistTurnResponse(db, 'chat', turn(calls(), 500));
    db.insert(schema.compactions).values({ ...summaries(1)[0]!, createdAt: 500 }).run();
    const result = await consume(archive, bounds);
    expect(result.items.every(item => item.chatId === 'chat')).toBe(true);
    expect(result.items.filter(item => item.kind === 'message')).toHaveLength(4);
    expect(result.items.filter(item => item.kind === 'model-output')).toHaveLength(3);
    expect(result.items.filter(item => item.kind === 'summary')).toHaveLength(3);
    const emittedKeys = result.batches.flatMap(batch => batch.changes.map(change => change.item.key));
    expect(emittedKeys).toHaveLength(16);
    expect(new Set(emittedKeys).size).toBe(emittedKeys.length);
    expect(result.batches.filter(batch => batch.progress.source === 'events').every(batch => batch.changes.length <= 1)).toBe(true);
    for (const source of ['events', 'turn_responses_v2', 'compactions'] as const) {
      const progress = result.batches.filter(b => b.progress.source === source).map(b => b.progress);
      expect(progress.at(-1)!.done).toBe(true);
      const keys = progress.filter(p => !p.done).map(p => p.after!.id);
      expect(new Set(keys).size).toBe(keys.length);
      expect(progress.every(p => p.bounds.chatId === 'chat')).toBe(true);
    }
    expect(result.items.findIndex(i => i.kind === 'message' && i.order.timeMs === 1000))
      .toBeLessThan(result.items.findIndex(i => i.kind === 'model-output'));
    const other = await consume(archive, archive.captureBounds('other'), 2);
    expect(other.items.every(item => item.chatId === 'other')).toBe(true);
    expect(other.items).toHaveLength(result.items.length);
  });

  it('updates earlier messages across pages, retains full reply snapshots and converges with one-shot Projection/rendering', async () => {
    const { db, archive } = fixture();
    const full = 'original <&> '.repeat(80);
    const events: PipelineEvent[] = [
      message('1', 1000, full),
      { ...message('2', 1000, 'reply'), replyToMessageId: '1' },
      { ...message('1', 2000, 'edited'), type: 'edit' },
      { type: 'delete', chatId: 'chat', messageIds: ['1'], receivedAtMs: 3000, timestampSec: 3, utcOffsetMin: 0 },
      { ...message('3', 4000, 'synthetic'), isSelfSent: true },
      { ...message('3', 5000, 'authoritative'), sender: { id: 'bot', displayName: 'Bot', isBot: true } },
      { ...message('4', 6000, 'reply after delete'), replyToMessageId: '1' },
      { ...message('5', 7000, 'quoted reply'), replyToMessageId: '1', replyQuoteContent: [{ type: 'bold', children: [{ type: 'text', text: full }] }] },
    ];
    events.forEach(event => persistEvent(db, event));
    const bounds = archive.captureBounds('chat');
    const result = await consume(archive, bounds);
    const expected = createRenderer().render(events.map(event => event.type === 'message' ? { ...event, replyQuoteContent: undefined } : event).reduce(reduce, createEmptyIC('chat')), {});
    expect(createRenderer().render(loadEvents(db, 'chat').reduce(reduce, createEmptyIC('chat')), {})).toEqual(expected);
    for (const record of expected) {
      if (record.kind !== 'message') continue;
      const item = result.items.find((item): item is HistoryMessage => item.kind === 'message' && item.metadata.messageId === record.metadata.messageId)!;
      expect(item.metadata).toEqual(record.metadata);
      expect(item.transcript).toEqual(record.transcript);
    }
    const first = result.items.find((item): item is HistoryMessage => item.kind === 'message' && item.metadata.messageId === '1')!;
    expect(first.metadata).toMatchObject({ receivedAtMs: 1000, deleted: true, editedAtSec: 2 });
    expect(first.transcript.text).toBe('edited');
    expect(first.source.id).not.toBe(first.changedBy.id);
    const reply = result.items.find((item): item is HistoryMessage => item.kind === 'message' && item.metadata.messageId === '2')!;
    expect(reply.transcript.reply!.text).toBe(full);
    const quoted = result.items.find((item): item is HistoryMessage => item.kind === 'message' && item.metadata.messageId === '5')!;
    expect(quoted.metadata.replyTo!.quoted).toBe(false);
    expect(quoted.transcript.reply!.text).toBe('edited');
    expect(loadEvents(db, 'chat').find(event => event.type === 'message' && event.messageId === '5')).not.toHaveProperty('replyQuoteContent');
    const echo = result.items.find((item): item is HistoryMessage => item.kind === 'message' && item.metadata.messageId === '3')!;
    expect(echo.metadata).toMatchObject({ receivedAtMs: 4000, isSelfSent: true });
    expect(echo.transcript.text).toBe('authoritative');
    const wider = await consume(archive, bounds, 3);
    expect(wider.items).toEqual(result.items);
    const edits = result.batches.flatMap(b => b.changes).filter(c => c.item.key === first.key);
    expect(edits).toHaveLength(3);
    expect(new Set(edits.map(e => e.item.sourceRevision)).size).toBe(3);
  });

  it('decodes original IR positions and matches tools only inside their own TR, preserving tools-only outputs', async () => {
    const { db, archive } = fixture();
    const entries: ConversationEntry[] = [{
      kind: 'message', role: 'assistant', reasoning: { reasoning_content: 'hidden', reasoning_opaque: 'opaque secret' },
      parts: [
        { kind: 'reasoning', data: { source: 'anthropicMessages', data: { type: 'redacted_thinking', data: 'opaque secret' } } },
        { kind: 'toolCall', callId: 'reused', name: 'one', args: `{"long":"${  'args'.repeat(1000)  }"}` },
      ],
    }, { kind: 'toolResult', callId: 'reused', payload: 'result'.repeat(1000), requiresFollowUp: true }, {
      kind: 'message', role: 'assistant', reasoning: undefined,
      parts: [{ kind: 'reasoning', data: { source: 'anthropicMessages', data: { type: 'thinking', thinking: 'hidden' } } }, {
        kind: 'textGroup', content: [{ kind: 'text', text: 'first' }, { kind: 'text', text: 'second' }],
      }],
    }];
    await persistTurnResponse(db, 'chat', turn(entries));
    await persistTurnResponse(db, 'chat', turn(calls('two')));
    const result = await consume(archive, archive.captureBounds('chat'));
    const tools = result.items.filter((item): item is HistoryTool => item.kind === 'tool-execution');
    const results = result.items.filter((item): item is HistoryResult => item.kind === 'tool-result');
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.name)).toEqual(['one', 'two']);
    expect(tools[0]!.position).toEqual({ entryIndex: 0, partIndex: 1 });
    expect(tools[0]!.args.length).toBeGreaterThan(4000);
    expect(results[0]!.payload).toBe('result'.repeat(1000));
    expect(results.map(r => r.toolKey)).toEqual(tools.map(t => t.key));
    expect(tools.map(t => t.resultKeys[0])).toEqual(results.map(r => r.key));
    expect(result.items.filter(i => i.kind === 'model-output')).toHaveLength(3);
    const grouped = result.items.find(i => i.kind === 'model-output' && i.entryIndex === 2)!;
    expect(grouped.kind === 'model-output' && grouped.parts.map(p => p.position)).toEqual([
      { entryIndex: 2, partIndex: 1, textIndex: 0 }, { entryIndex: 2, partIndex: 1, textIndex: 1 },
    ]);
    expect(JSON.stringify(result.items)).not.toMatch(/hidden|opaque secret|reasoning/);
  });

  it('keeps ambiguous and orphan results explicit and replaces image bytes with source positions', async () => {
    const { db, archive } = fixture();
    const entries = calls();
    entries.push({ ...entries[0]! });
    entries.push({
      kind: 'toolResult', callId: 'orphan', payload: [
        { kind: 'image', image: sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png(), detail: 'high' },
        { kind: 'text', text: 'image description' },
      ], requiresFollowUp: false,
    });
    await persistTurnResponse(db, 'chat', turn(entries));
    const result = await consume(archive, archive.captureBounds('chat'));
    expect(result.items.filter(i => i.kind === 'tool-execution').every(i => i.pairing === 'ambiguous')).toBe(true);
    const orphan = result.items.find((i): i is HistoryResult => i.kind === 'tool-result' && i.callId === 'orphan')!;
    expect(orphan.payload).toEqual([
      { kind: 'image', position: { entryIndex: 3, partIndex: 0 } },
      { kind: 'text', text: 'image description', position: { entryIndex: 3, partIndex: 1 } },
    ]);
    expect(orphan.pairing).toBe('missing');
    expect(JSON.stringify(result.items)).not.toMatch(/base64|toBuffer|"image":/);
  });

  it('includes every compaction with creation time and exclusive coverage, without invented inheritance', async () => {
    const { db, archive } = fixture();
    db.insert(schema.compactions).values(summaries(5)).run();
    const result = await consume(archive, archive.captureBounds('chat'), 2);
    const items = result.items.filter(i => i.kind === 'summary');
    expect(items).toHaveLength(5);
    expect(items.map(i => i.coverage)).toEqual(summaries(5).map(row => ({ fromReceivedAtMs: row.oldCursorMs, untilReceivedAtMs: row.newCursorMs })));
    expect(items.every(i => i.createdAtMs === 1000 && i.order.timeMs === 1000)).toBe(true);
    expect(items.map(i => i.compactionId)).toEqual([1, 2, 3, 4, 5]);
    expect(JSON.stringify(items)).not.toMatch(/previous|parent|trigger/);
  });

  it('attaches completion only through explicit bash task identity and reports unresolved boundaries', async () => {
    const { db, archive } = fixture();
    const entries = calls('bash');
    entries[1] = { kind: 'toolResult', callId: 'reused', payload: '{"background_task_id":7}', requiresFollowUp: false };
    await persistTurnResponse(db, 'chat', turn(entries));
    for (const taskId of [7, 8]) persistEvent(db, {
      type: 'runtime', chatId: 'chat', receivedAtMs: 9000, timestampSec: 9, utcOffsetMin: 0,
      kind: 'task_completed', taskId, taskType: 'bash', finalSummary: 'complete'.repeat(500), hasFullOutput: true,
    });
    const result = await consume(archive, archive.captureBounds('chat'));
    const tool = result.items.find((i): i is HistoryTool => i.kind === 'tool-execution')!;
    expect(tool.completion).toMatchObject({ taskId: 7, finalSummary: 'complete'.repeat(500), source: { source: 'events', chatId: 'chat' } });
    expect(result.notices).toMatchObject([{ kind: 'unlinked-task-completion', taskId: 8 }]);
    expect(result.items.map(i => i.kind)).toEqual(['model-output', 'tool-execution', 'tool-result']);
  });

  it('reuses cached media descriptions without resolver calls and emits only serializable data', async () => {
    const { db, archive } = fixture();
    const thumbnailWebp = (await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).webp().toBuffer()).toString('base64');
    db.insert(schema.imageAltTexts).values([
      { imageHash: computeThumbnailHash(thumbnailWebp), altText: 'cached photo', altTextTokens: 1, createdAt: 1 },
      { imageHash: 'emoji:42', altText: 'cached emoji', altTextTokens: 1, createdAt: 1 },
    ]).run();
    persistEvent(db, {
      ...message('media', 1000), attachments: [{ type: 'photo', thumbnailWebp }, { type: 'document', fileName: 'full.pdf' }],
      content: [{ type: 'custom_emoji', customEmojiId: '42', children: [{ type: 'text', text: 'x' }] }],
    });
    const hydrate = createCachedAltTextHydrator({ lookup: hash => loadImageAltTextByHash(db, hash), enabled: () => true });
    const result = await consume(archive, archive.captureBounds('chat'), 1, hydrate);
    const item = result.items[0] as HistoryMessage;
    expect(item.metadata.attachments[0]!.altText).toBe('cached photo');
    expect(item.transcript.xml).toContain('cached emoji');
    expect(item.transcript.xml).toContain('full.pdf');
    expect(JSON.stringify(result.items)).not.toContain(thumbnailWebp);
    expect(JSON.parse(JSON.stringify(result.items))).toMatchObject([{ kind: 'message', transcript: { xml: item.transcript.xml } }]);
  });

  it('fails on invalid page limits and malformed stored IR instead of skipping source rows', async () => {
    const { db, archive } = fixture();
    const bounds = archive.captureBounds('chat');
    expect(() => archive.readEvents({ bounds, limit: 0 })).toThrow('positive safe integer');
    await expect(archive.readTurns({ bounds, limit: 1.5 })).rejects.toThrow('positive safe integer');
    db.insert(schema.turnResponsesV2).values({ chatId: 'chat', requestedAt: 1, entries: '{}', inputTokens: 0, outputTokens: 0 }).run();
    await expect(consume(archive, archive.captureBounds('chat'))).rejects.toThrow('Invalid codec format');
    expect(await codec.parse(await codec.stringify([]))).toEqual([]);
  });
});
