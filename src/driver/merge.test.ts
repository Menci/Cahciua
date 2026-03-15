import { describe, expect, it } from 'vitest';

import { mergeContext } from './merge';
import type { ContextChunk, TRDataEntry, TurnResponse } from './types';
import type { RenderedContext } from '../rendering/types';

const textSeg = (ts: number, text: string): RenderedContext[number] => ({
  receivedAtMs: ts,
  content: [{ type: 'text', text }],
});

const tr = (ts: number, data: TRDataEntry[]): TurnResponse => ({
  requestedAtMs: ts,
  provider: 'openai-chat',
  data,
  inputTokens: 0,
  outputTokens: 0,
});

const assistantData = (text: string): TRDataEntry => ({ role: 'assistant', content: text });
const toolCallData = (id: string, name: string, args: string): TRDataEntry => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
});
const toolResultData = (id: string, content: string): TRDataEntry => ({
  role: 'tool',
  tool_call_id: id,
  content,
});

const rcChunk = (time: number, content: RenderedContext[number]['content']): ContextChunk =>
  ({ type: 'rc', time, step: -1, content });

const trChunk = (time: number, step: number, data: unknown): ContextChunk =>
  ({ type: 'tr', provider: 'openai-chat', time, step, data });

describe('mergeContext', () => {
  it('returns empty array for empty inputs', () => {
    expect(mergeContext([], [])).toEqual([]);
  });

  it('merges RC-only into a single rc chunk', () => {
    const rc: RenderedContext = [
      textSeg(1000, 'hello'),
      textSeg(2000, 'world'),
    ];
    const result = mergeContext(rc, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(rcChunk(2000, [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]));
  });

  it('interleaves RC and TR by timestamp', () => {
    const rc: RenderedContext = [
      textSeg(1000, 'msg1'),
      textSeg(2000, 'msg2'),
      textSeg(4000, 'msg3'),
    ];
    const trs = [tr(3000, [assistantData('reply1')])];

    const result = mergeContext(rc, trs);
    expect(result).toHaveLength(3);
    // First rc chunk: msg1 + msg2 (both before TR at 3000)
    expect(result[0]).toEqual(rcChunk(2000, [
      { type: 'text', text: 'msg1' },
      { type: 'text', text: 'msg2' },
    ]));
    // TR chunk
    expect(result[1]).toEqual(trChunk(3000, 0, assistantData('reply1')));
    // Second rc chunk: msg3 (after TR)
    expect(result[2]).toEqual(rcChunk(4000, [
      { type: 'text', text: 'msg3' },
    ]));
  });

  it('applies tiebreaker: RC before TR on equal timestamp', () => {
    const rc: RenderedContext = [textSeg(1000, 'simultaneous')];
    const trs = [tr(1000, [assistantData('reply')])];

    const result = mergeContext(rc, trs);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(rcChunk(1000, [
      { type: 'text', text: 'simultaneous' },
    ]));
    expect(result[1]).toEqual(trChunk(1000, 0, assistantData('reply')));
  });

  it('handles tool call loop within a single TR', () => {
    const rc: RenderedContext = [
      textSeg(1000, 'original'),
      textSeg(2500, 'arrived during tool exec'),
    ];
    const trs = [
      tr(1500, [
        toolCallData('tc1', 'send_message', '{"text":"hi"}'),
        toolResultData('tc1', '{"ok":true}'),
        assistantData('done'),
      ]),
    ];

    const result = mergeContext(rc, trs);
    // rc(original) → tr(tool_call) → tr(tool_result) → tr(assistant) → rc(arrived during)
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual(rcChunk(1000, [{ type: 'text', text: 'original' }]));
    expect(result[1]).toEqual(trChunk(1500, 0, toolCallData('tc1', 'send_message', '{"text":"hi"}')));
    expect(result[2]).toEqual(trChunk(1500, 1, toolResultData('tc1', '{"ok":true}')));
    expect(result[3]).toEqual(trChunk(1500, 2, assistantData('done')));
    expect(result[4]).toEqual(rcChunk(2500, [{ type: 'text', text: 'arrived during tool exec' }]));
  });

  it('handles image content pieces', () => {
    const rc: RenderedContext = [
      {
        receivedAtMs: 1000,
        content: [
          { type: 'text', text: 'photo:' },
          { type: 'image', url: 'data:image/png;base64,abc' },
        ],
      },
    ];
    const result = mergeContext(rc, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(rcChunk(1000, [
      { type: 'text', text: 'photo:' },
      { type: 'image', url: 'data:image/png;base64,abc' },
    ]));
  });

  it('handles TR-only input (no RC)', () => {
    const trs = [tr(1000, [assistantData('hello')])];
    const result = mergeContext([], trs);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(trChunk(1000, 0, assistantData('hello')));
  });

  it('handles multiple consecutive TRs without RC between them', () => {
    const rc: RenderedContext = [textSeg(1000, 'start')];
    const trs = [
      tr(2000, [assistantData('first')]),
      tr(3000, [assistantData('second')]),
    ];
    const result = mergeContext(rc, trs);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(rcChunk(1000, [{ type: 'text', text: 'start' }]));
    expect(result[1]).toEqual(trChunk(2000, 0, assistantData('first')));
    expect(result[2]).toEqual(trChunk(3000, 0, assistantData('second')));
  });

  it('preserves TR data entry order within a single TR', () => {
    const rc: RenderedContext = [textSeg(1000, 'context')];
    const trs = [
      tr(2000, [
        toolCallData('tc1', 'send_message', '{}'),
        toolResultData('tc1', 'ok'),
        assistantData('final'),
      ]),
    ];
    const result = mergeContext(rc, trs);
    expect(result).toHaveLength(4);
    expect(result[1]).toEqual(trChunk(2000, 0, toolCallData('tc1', 'send_message', '{}')));
    expect(result[2]).toEqual(trChunk(2000, 1, toolResultData('tc1', 'ok')));
    expect(result[3]).toEqual(trChunk(2000, 2, assistantData('final')));
  });
});
