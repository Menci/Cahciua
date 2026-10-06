import { Format, initLogger, LogLevel } from '@guiiai/logg';
import { describe, expect, it } from 'vitest';

import { selectContextView } from './driver/context-view';
import { createPipeline } from './pipeline';
import type { PipelineEvent } from './projection';
import { rcToXml } from './rendering';

initLogger(LogLevel.Error, Format.Pretty);

const message = (id: string, at: number, text = id): Extract<PipelineEvent, { type: 'message' }> => ({
  type: 'message', chatId: 'chat', messageId: id,
  receivedAtMs: at, timestampSec: at / 1000, utcOffsetMin: 0,
  sender: { id: 'user', displayName: 'User', isBot: false },
  content: [{ type: 'text', text }], attachments: [],
});

const edit = (id: string, at: number, text: string): Extract<PipelineEvent, { type: 'edit' }> => ({
  ...message(id, at, text), type: 'edit',
});

describe('Pipeline model timeline characterization', () => {
  it('keeps original order and reply snapshots across edits and deletes', () => {
    const pipeline = createPipeline({ botUserId: 'bot' });
    pipeline.pushEvent('chat', message('1', 1000, 'original'));
    pipeline.pushEvent('chat', { ...message('2', 2000, 'reply'), replyToMessageId: '1' });
    const edited = pipeline.pushEvent('chat', edit('1', 3000, 'replacement'));
    expect(edited.map(segment => segment.receivedAtMs)).toEqual([1000, 2000]);
    expect(rcToXml(edited)).toContain('>original</in-reply-to>');
    expect(rcToXml(edited)).toContain('replacement');
    const deleted = pipeline.pushEvent('chat', {
      type: 'delete', chatId: 'chat', messageIds: ['1'], receivedAtMs: 4000, timestampSec: 4, utcOffsetMin: 0,
    });
    expect(rcToXml(deleted)).toContain('deleted="true"');
    expect(rcToXml(deleted)).not.toContain('replacement');
    expect(rcToXml(deleted)).toContain('>original</in-reply-to>');
  });

  it('replaces a synthetic send with its authoritative echo without moving it', () => {
    const pipeline = createPipeline({ botUserId: 'bot' });
    pipeline.pushEvent('chat', { ...message('1', 1000, 'synthetic'), isSelfSent: true });
    const echoed = pipeline.pushEvent('chat', message('1', 2000, 'authoritative'));
    expect(echoed).toHaveLength(1);
    expect(echoed[0]).toMatchObject({ receivedAtMs: 1000, isSelfSent: true });
    expect(rcToXml(echoed)).toContain('authoritative');
    expect(rcToXml(echoed)).not.toContain('synthetic');
  });
});

describe('Pipeline rendering reuse', () => {
  it('advances one chat cursor without regenerating retained bodies or images', () => {
    const pipeline = createPipeline({});
    pipeline.pushEvent('chat', message('1', 1000));
    const before = pipeline.pushEvent('chat', {
      ...message('2', 2000), attachments: [{ type: 'photo', thumbnailWebp: 'aGVsbG8=' }],
    });
    const other = pipeline.pushEvent('other', { ...message('3', 1000), chatId: 'other' });
    pipeline.setCompactCursor('chat', 2000);
    const retained = pipeline.getRenderedChats().find(([id]) => id === 'chat')![1];
    expect(retained).toEqual([before[1]]);
    expect(retained[0]).toBe(before[1]);
    expect(pipeline.getRenderedChats().find(([id]) => id === 'other')![1]).toBe(other);
    const after = pipeline.pushEvent('chat', message('4', 3000));
    expect(after.map(node => node.source.type === 'message' && node.source.messageId)).toEqual(['2', '4']);
    expect(after[0]).toBe(before[1]);
    expect(after[0]!.content[1]).toBe(before[1]!.content[1]);
    expect(pipeline.getCompactCursor('other')).toBeUndefined();
  });

  it('refreshes edits, deletion and attachment descriptions without rebuilding neighbours', () => {
    const pipeline = createPipeline({});
    pipeline.pushEvent('chat', message('1', 1000));
    const before = pipeline.pushEvent('chat', message('2', 2000));
    const after = pipeline.pushEvent('chat', {
      ...edit('1', 3000, 'updated'), attachments: [{ type: 'photo', altText: 'a lighthouse' }],
    });
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(rcToXml(after)).toContain('a lighthouse');
    expect(after[0]!.source).toMatchObject({ messageId: '1', receivedAtMs: 1000, editedAtSec: 3 });
    const deleted = pipeline.pushEvent('chat', {
      type: 'delete', chatId: 'chat', messageIds: ['1'], receivedAtMs: 4000, timestampSec: 4, utcOffsetMin: 0,
    });
    expect(deleted[1]).toBe(before[1]);
    expect(rcToXml(deleted)).not.toContain('a lighthouse');
  });

  it('invalidates formatting when the same contact map changes', () => {
    const contacts = new Map([['user', 'Before']]);
    const params = { contactNames: contacts, botUserId: 'bot' };
    const pipeline = createPipeline(params);
    const before = pipeline.pushEvent('chat', message('1', 1000));
    contacts.set('user', 'After');
    const after = pipeline.pushEvent('chat', message('2', 2000));
    expect(after[0]).not.toBe(before[0]);
    expect(rcToXml(after)).not.toContain('sender="Before"');
    expect(rcToXml(after)).toContain('sender="After"');
    params.botUserId = 'user';
    expect(pipeline.pushEvent('chat', message('3', 3000))[0]!.isMyself).toBe(true);
  });

  it('replays only resident records while preserving source state for replies', () => {
    const pipeline = createPipeline({});
    pipeline.setCompactCursor('chat', 2000);
    const records = pipeline.replayChat('chat', [message('1', 1000, 'old'), {
      ...message('2', 2000), replyToMessageId: '1',
    }]);
    expect(records).toHaveLength(1);
    expect(rcToXml(records)).toContain('>old</in-reply-to>');
    expect(selectContextView(records, { cursorMs: 2000 })).toHaveLength(1);
  });
});

it('reuses unchanged replay records and refreshes only newly hydrated media', () => {
  const pipeline = createPipeline({});
  const first = message('1', 1000);
  const image = { ...message('2', 2000), attachments: [{ type: 'photo' as const, thumbnailWebp: 'aGVsbG8=' }] };
  const before = pipeline.replayChat('chat', [first, image]);
  const equivalent = pipeline.replayChat('chat', [structuredClone(first), structuredClone(image)]);
  expect(equivalent[0]).toBe(before[0]);
  expect(equivalent[1]).toBe(before[1]);
  const hydrated = pipeline.replayChat('chat', [first, {
    ...image, attachments: [{ ...image.attachments[0]!, altText: 'a harbour' }],
  }]);
  expect(hydrated[0]).toBe(before[0]);
  expect(hydrated[1]).not.toBe(before[1]);
  expect(hydrated[1]!.content).toHaveLength(1);
  expect(rcToXml(hydrated)).toContain('a harbour');
});
