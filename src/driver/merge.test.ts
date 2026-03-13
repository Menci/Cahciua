import { describe, expect, it } from 'vitest';

import { mergeContext } from './merge';
import type { TurnResponse } from './types';
import type { RenderedContext } from '../rendering/types';

const textSeg = (ts: number, text: string): RenderedContext[number] => ({
  receivedAtMs: ts,
  content: [{ type: 'text', text }],
});

const tr = (ts: number, data: unknown[]): TurnResponse => ({
  requestedAtMs: ts,
  provider: 'openai-chat',
  data,
  inputTokens: 0,
  outputTokens: 0,
});

const assistantMsg = (text: string) => ({ role: 'assistant', content: text });
const toolCallMsg = (id: string, name: string, args: string) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
});
const toolResultMsg = (id: string, content: string) => ({
  role: 'tool',
  tool_call_id: id,
  content,
});

describe('mergeContext', () => {
  it('returns empty array for empty inputs', () => {
    expect(mergeContext([], [])).toEqual([]);
  });

  it('merges RC-only into a single user message', () => {
    const rc: RenderedContext = [
      textSeg(1000, 'hello'),
      textSeg(2000, 'world'),
    ];
    const result = mergeContext(rc, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ],
    });
  });

  it('interleaves RC and TR by timestamp', () => {
    const rc: RenderedContext = [
      textSeg(1000, 'msg1'),
      textSeg(2000, 'msg2'),
      textSeg(4000, 'msg3'),
    ];
    const trs = [tr(3000, [assistantMsg('reply1')])];

    const result = mergeContext(rc, trs);
    expect(result).toHaveLength(3);
    // First user message: msg1 + msg2 (both before TR at 3000)
    expect(result[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'msg1' },
        { type: 'text', text: 'msg2' },
      ],
    });
    // Assistant message from TR
    expect(result[1]).toEqual(assistantMsg('reply1'));
    // Second user message: msg3 (after TR)
    expect(result[2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'msg3' }],
    });
  });

  it('applies tiebreaker: RC before TR on equal timestamp', () => {
    const rc: RenderedContext = [textSeg(1000, 'simultaneous')];
    const trs = [tr(1000, [assistantMsg('reply')])];

    const result = mergeContext(rc, trs);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'simultaneous' }],
    });
    expect(result[1]).toEqual(assistantMsg('reply'));
  });

  it('handles tool call loop within a single TR', () => {
    // One generateText call produces one TR with all steps:
    // tool_call + tool_result + final assistant — all share the same requestedAtMs.
    // RC segment that arrived during tool exec sorts after the TR (higher timestamp).
    const rc: RenderedContext = [
      textSeg(1000, 'original'),
      textSeg(2500, 'arrived during tool exec'),
    ];
    const trs = [
      tr(1500, [
        toolCallMsg('tc1', 'send_message', '{"text":"hi"}'),
        toolResultMsg('tc1', '{"ok":true}'),
        assistantMsg('done'),
      ]),
    ];

    const result = mergeContext(rc, trs);
    // user(original) → tool_call → tool_result → assistant(done) → user(arrived during)
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'original' }],
    });
    expect(result[1]).toEqual(toolCallMsg('tc1', 'send_message', '{"text":"hi"}'));
    expect(result[2]).toEqual(toolResultMsg('tc1', '{"ok":true}'));
    expect(result[3]).toEqual(assistantMsg('done'));
    expect(result[4]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'arrived during tool exec' }],
    });
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
    expect(result[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'photo:' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'low' } },
      ],
    });
  });

  it('handles TR-only input (no RC)', () => {
    const trs = [tr(1000, [assistantMsg('hello')])];
    const result = mergeContext([], trs);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(assistantMsg('hello'));
  });

  it('handles multiple consecutive TRs without RC between them', () => {
    const rc: RenderedContext = [textSeg(1000, 'start')];
    const trs = [
      tr(2000, [assistantMsg('first')]),
      tr(3000, [assistantMsg('second')]),
    ];
    const result = mergeContext(rc, trs);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'start' }],
    });
    expect(result[1]).toEqual(assistantMsg('first'));
    expect(result[2]).toEqual(assistantMsg('second'));
  });

  it('preserves TR data entry order within a single TR', () => {
    const rc: RenderedContext = [textSeg(1000, 'context')];
    const trs = [
      tr(2000, [
        toolCallMsg('tc1', 'send_message', '{}'),
        toolResultMsg('tc1', 'ok'),
        assistantMsg('final'),
      ]),
    ];
    const result = mergeContext(rc, trs);
    expect(result).toHaveLength(4);
    expect(result[1]).toEqual(toolCallMsg('tc1', 'send_message', '{}'));
    expect(result[2]).toEqual(toolResultMsg('tc1', 'ok'));
    expect(result[3]).toEqual(assistantMsg('final'));
  });
});
