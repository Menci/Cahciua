import { Format, initLogger, LogLevel } from '@guiiai/logg';
import { describe, expect, it } from 'vitest';

import { createRenderer, render, renderedRecordsToXml } from './index';
import type { BaseRenderedContext } from './types';
import { selectContextView } from '../driver/context-view';
import { createPipeline } from '../pipeline';
import { createEmptyIC, reduce } from '../projection';
import type { PipelineEvent } from '../projection';

initLogger(LogLevel.Error, Format.Pretty);

const message = (id: string, at: number, text = id, chatId = 'chat'): Extract<PipelineEvent, { type: 'message' }> => ({
  type: 'message', chatId, messageId: id, receivedAtMs: at, timestampSec: at / 1000, utcOffsetMin: 0,
  sender: { id: 'user', displayName: 'User', isBot: false },
  content: [{ type: 'text', text }], attachments: [],
});
const restore = (events: PipelineEvent[], chatId = 'chat') =>
  events.reduce(reduce, createEmptyIC(chatId));
const ids = (records: BaseRenderedContext) => records.map(record =>
  record.kind === 'message' ? record.metadata.messageId : record.kind);

// The history consumer is deliberately just independent IC + renderer + range:
// no online Pipeline, compaction metadata, Driver view or archive infrastructure.
describe('shared rendering windows', () => {
  it('serves online and history consumers with independent state and windows', () => {
    const events: PipelineEvent[] = [
      message('1', 1000, 'before window'),
      message('2', 2000, 'history only'),
      { ...message('3', 3000, 'online reply'), replyToMessageId: '1' },
    ];
    const pipeline = createPipeline({});
    pipeline.setRenderWindow('chat', { fromReceivedAtMs: 3000 });
    const online = pipeline.replayChat('chat', events);
    let historyState = restore(structuredClone(events));
    const history = createRenderer();
    const older = history.render(historyState, {}, { fromReceivedAtMs: 1000, untilReceivedAtMs: 3000 });
    expect(ids(online)).toEqual(['3']);
    expect(ids(older)).toEqual(['1', '2']);
    expect(historyState).not.toBe(pipeline.getIC('chat'));
    const sameWindow = history.render(historyState, {}, { fromReceivedAtMs: 3000 });
    expect(sameWindow).toEqual(online);
    expect(sameWindow[0]).not.toBe(online[0]);
    expect(renderedRecordsToXml(sameWindow)).toContain('>before window</in-reply-to>');
    expect(selectContextView(online, { blockedUserIds: new Set(['user']) })[0]!.content)
      .toEqual(online[0]!.kind === 'message' ? online[0]!.presentation.blocked : []);
    expect(renderedRecordsToXml(sameWindow)).toContain('online reply');

    const edit: PipelineEvent = { ...message('1', 4000, 'edited outside online window'), type: 'edit' };
    pipeline.pushEvent('chat', edit);
    expect(renderedRecordsToXml(history.render(historyState, {}, { untilReceivedAtMs: 2000 })))
      .toContain('before window');
    historyState = reduce(historyState, structuredClone(edit));
    expect(renderedRecordsToXml(history.render(historyState, {}, { untilReceivedAtMs: 2000 })))
      .toContain('edited outside online window');
    const deletion: PipelineEvent = {
      type: 'delete', chatId: 'chat', messageIds: ['2'], receivedAtMs: 5000, timestampSec: 5, utcOffsetMin: 0,
    };
    historyState = reduce(historyState, deletion);
    const updated = history.render(historyState, {}, { fromReceivedAtMs: 1000, untilReceivedAtMs: 3000 });
    expect(updated[0]!.metadata).toMatchObject({ messageId: '1', receivedAtMs: 1000, editedAtSec: 4 });
    expect(updated[1]!.metadata).toMatchObject({ messageId: '2', deleted: true });
    expect(renderedRecordsToXml(updated)).not.toContain('history only');
    expect(renderedRecordsToXml(history.render(historyState, {}, { fromReceivedAtMs: 3000 })))
      .toContain('>before window</in-reply-to>');
    pipeline.setRenderWindow('chat', { fromReceivedAtMs: 6000 });
    expect(pipeline.getRenderedChats()[0]![1]).toEqual([]);
    expect(ids(history.render(historyState, {}, { untilReceivedAtMs: 3000 }))).toEqual(['1', '2']);
  });

  it('uses inclusive start and exclusive end for every node kind, without dropping tied timestamps', () => {
    const events: PipelineEvent[] = [message('1', 1000), message('2', 2000), message('3', 2000), message('4', 3000), {
      type: 'runtime', chatId: 'chat', kind: 'task_completed', taskId: 1, taskType: 'shell',
      intention: 'work', finalSummary: 'done', hasFullOutput: false,
      receivedAtMs: 2000, timestampSec: 2, utcOffsetMin: 0,
    }, {
      type: 'service', chatId: 'chat', action: { action: 'chat_renamed', newTitle: 'New title' },
      receivedAtMs: 3000, timestampSec: 3, utcOffsetMin: 0,
    }];
    const state = restore(events);
    const renderer = createRenderer();
    const window = { fromReceivedAtMs: 2000, untilReceivedAtMs: 3000 };
    expect(ids(render(state, {}, window))).toEqual(['2', '3', 'runtime']);
    expect(renderer.render(state, {}, window)).toEqual(render(state, {}, window));
    expect(ids(renderer.render(state, {}, { fromReceivedAtMs: 3000 }))).toEqual(['4', 'system']);
    expect(renderer.render(state, {}, { fromReceivedAtMs: 2000, untilReceivedAtMs: 2000 })).toEqual([]);
    const other = restore([message('2', 2000, 'other chat', 'other')], 'other');
    expect(renderer.render(other, {}, window)[0]!.metadata.chatId).toBe('other');
    expect(renderedRecordsToXml(renderer.render(other, {}, window))).toContain('other chat');
  });

  it('selects before body, metadata, revision or image construction on both entry points', () => {
    const state = restore([message('1', 1000), message('2', 2000), message('3', 3000)]);
    const outside = state.nodes[0]!;
    if (outside.type !== 'message') throw new Error('Expected message fixture');
    const excludedAt = (receivedAtMs: number) => ({
      ...outside, receivedAtMs, get content(): typeof outside.content {
        throw new Error('Window-excluded content must not be read');
      },
    });
    const input = { ...state, nodes: [excludedAt(1000), state.nodes[1]!, excludedAt(3000)] };
    const window = { fromReceivedAtMs: 2000, untilReceivedAtMs: 3000 };
    expect(ids(render(input, {}, window))).toEqual(['2']);
    expect(ids(createRenderer().render(input, {}, window))).toEqual(['2']);
  });

  it('retains overlapping body/image identity and releases cache outside the supplied window', () => {
    const state = restore([message('1', 1000), {
      ...message('2', 2000), attachments: [{ type: 'photo', thumbnailWebp: 'aGVsbG8=', altText: undefined }],
    }, message('3', 3000)]);
    const renderer = createRenderer();
    const first = renderer.render(state, {}, { untilReceivedAtMs: 3000 });
    renderer.retainWindow({ fromReceivedAtMs: 2000, untilReceivedAtMs: 4000 });
    const next = renderer.render(state, {}, { fromReceivedAtMs: 2000, untilReceivedAtMs: 4000 });
    expect(ids(next)).toEqual(['2', '3']);
    expect(next[0]).toBe(first[1]);
    expect(next[0]!.presentation.body[1]).toBe(first[1]!.presentation.body[1]);
    const older = renderer.render(state, {}, { untilReceivedAtMs: 2000 });
    expect(older[0]).not.toBe(first[0]);
    const reentered = renderer.render(state, {}, { fromReceivedAtMs: 2000, untilReceivedAtMs: 3000 });
    expect(reentered[0]).not.toBe(first[1]);
    expect(renderedRecordsToXml(reentered)).toBe(renderedRecordsToXml(render(state, {}, { fromReceivedAtMs: 2000, untilReceivedAtMs: 3000 })));
    expect(reentered[0]!.metadata).toEqual(first[1]!.metadata);
  });
});
