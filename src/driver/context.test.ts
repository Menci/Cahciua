import { describe, expect, it } from 'vitest';

import { composeContext, loopEndedWithoutSendMessage } from './context';
import type { TurnResponseV2 } from './types';
import type { RenderedContext } from '../rendering/types';
import type { ConversationEntry, InputPart, ToolResult } from '../unified-api/types';

const CURRENT_MODEL = 'test-model';

const textSeg = (ts: number, text: string): RenderedContext[number] => ({
  receivedAtMs: ts,
  content: [{ type: 'text', text }],
});

const tr = (ts: number, entries: ConversationEntry[], modelName = CURRENT_MODEL): TurnResponseV2 => ({
  requestedAtMs: ts,
  entries,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  modelName,
});

const assistantText = (text: string): ConversationEntry => ({
  kind: 'message',
  role: 'assistant',
  parts: [{ kind: 'text', text }],
  reasoning: undefined,
});

const assistantToolCall = (callId: string, name = 'read'): ConversationEntry => ({
  kind: 'message',
  role: 'assistant',
  parts: [{ kind: 'toolCall', callId, name, args: '{}' }],
  reasoning: undefined,
});

const toolResult = (callId: string, payload: string | InputPart[]): ToolResult => ({
  kind: 'toolResult',
  callId,
  payload,
  requiresFollowUp: true,
});

const longText = (label: string): string => `${label}:${'x'.repeat(1000)}`;

const getToolResults = (entries: ConversationEntry[]): ToolResult[] =>
  entries.filter((e): e is ToolResult => e.kind === 'toolResult');

describe('composeContext — trimToolResults', () => {
  it('keeps only the last 5 oversized tool results untrimmed', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const contents = Array.from({ length: 7 }, (_, i) => longText(`r${i + 1}`));
    const trs = contents.map((c, i) =>
      tr(200 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, c)]));

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const tres = getToolResults(result!.entries);
    expect(tres).toHaveLength(7);
    expect(tres[0]!.payload).toMatch(/\[trimmed/);
    expect(tres[1]!.payload).toMatch(/\[trimmed/);
    for (let i = 2; i < 7; i++) expect(tres[i]!.payload).toBe(contents[i]);
  });

  it('does nothing when there are exactly 5 oversized tool results', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const contents = Array.from({ length: 5 }, (_, i) => longText(`r${i + 1}`));
    const trs = contents.map((c, i) =>
      tr(200 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, c)]));

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const tres = getToolResults(result!.entries);
    for (let i = 0; i < 5; i++) expect(tres[i]!.payload).toBe(contents[i]);
  });

  it('trimmed content preserves head and tail', () => {
    const content = `HEAD${'x'.repeat(800)}TAIL`;
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs: TurnResponseV2[] = [
      tr(200, [assistantToolCall('tc0'), toolResult('tc0', content)]),
      ...Array.from({ length: 5 }, (_, i) =>
        tr(300 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, longText(`r${i + 1}`))])),
    ];

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const trimmed = getToolResults(result!.entries)[0]!.payload as string;
    expect(trimmed).toContain('HEAD');
    expect(trimmed).toContain('TAIL');
    expect(trimmed).toContain('[trimmed');
  });

  it('preserves assistant entries when trimming older oversized tool results', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs: TurnResponseV2[] = [
      tr(200, [
        assistantToolCall('tc0'),
        toolResult('tc0', longText('oldest')),
        assistantText('I read the file'),
      ]),
      ...Array.from({ length: 5 }, (_, i) =>
        tr(300 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, longText(`r${i + 1}`))])),
    ];

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const entries = result!.entries;
    const tres = getToolResults(entries);
    expect(tres[0]!.payload).toMatch(/\[trimmed/);
    const hasAssistantText = entries.some(e =>
      e.kind === 'message' && e.role === 'assistant'
      && e.parts.some(p => p.kind === 'text' && p.text === 'I read the file'));
    expect(hasAssistantText).toBe(true);
  });
});

describe('composeContext — reasoning strip on model mismatch', () => {
  const reasoningEntry: ConversationEntry = {
    kind: 'message',
    role: 'assistant',
    parts: [
      { kind: 'reasoning', data: { source: 'anthropicMessages', data: { type: 'thinking', thinking: 'hmm', signature: 'sig' } } },
      { kind: 'text', text: 'answer' },
    ],
    reasoning: undefined,
  };

  it('preserves reasoning when modelName matches current model', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [tr(200, [reasoningEntry], CURRENT_MODEL)];

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const assistant = result!.entries.find(e => e.kind === 'message' && e.role === 'assistant');
    expect(assistant).toBeDefined();
    const hasReasoning = (assistant as { parts: { kind: string }[] }).parts
      .some(p => p.kind === 'reasoning');
    expect(hasReasoning).toBe(true);
  });

  it('strips reasoning when modelName differs from current model', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [tr(200, [reasoningEntry], 'other-model')];

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const assistant = result!.entries.find(e => e.kind === 'message' && e.role === 'assistant');
    expect(assistant).toBeDefined();
    const hasReasoning = (assistant as { parts: { kind: string }[] }).parts
      .some(p => p.kind === 'reasoning');
    expect(hasReasoning).toBe(false);
  });
});

describe('composeContext — misc', () => {
  it('returns null when rc + trs + summary are all empty', () => {
    expect(composeContext([], [], 100_000, CURRENT_MODEL)).toBeNull();
  });

  it('prepends compact summary as first user message', () => {
    const result = composeContext([textSeg(100, 'hi')], [], 100_000, CURRENT_MODEL, 'earlier stuff');
    expect(result).not.toBeNull();
    const first = result!.entries[0]!;
    expect(first.kind).toBe('message');
    expect(first.kind === 'message' && first.role === 'user').toBe(true);
    const firstText = first.kind === 'message' && first.role === 'user'
      && first.parts[0]!.kind === 'text' ? first.parts[0]!.text : '';
    expect(firstText).toContain('Conversation summary');
    expect(firstText).toContain('earlier stuff');
  });
});

describe('loopEndedWithoutSendMessage', () => {
  const sendMsgTr = (ts: number): TurnResponseV2 => tr(ts, [
    { kind: 'message', role: 'assistant', parts: [{ kind: 'toolCall', callId: `c${ts}`, name: 'send_message', args: '{"text":"hi"}' }], reasoning: undefined },
    { kind: 'toolResult', callId: `c${ts}`, payload: '{"ok":true}', requiresFollowUp: false },
  ]);
  const endTurnTr = (ts: number): TurnResponseV2 => tr(ts, [
    { kind: 'message', role: 'assistant', parts: [{ kind: 'toolCall', callId: `c${ts}`, name: 'end_turn', args: '{}' }], reasoning: undefined },
    { kind: 'toolResult', callId: `c${ts}`, payload: '{"ok":true}', requiresFollowUp: false },
  ]);
  const reactTr = (ts: number): TurnResponseV2 => tr(ts, [
    { kind: 'message', role: 'assistant', parts: [{ kind: 'toolCall', callId: `c${ts}`, name: 'react', args: '{"emoji":"👍","message_id":"1"}' }], reasoning: undefined },
    { kind: 'toolResult', callId: `c${ts}`, payload: '{"ok":true}', requiresFollowUp: true },
  ]);
  const bashTr = (ts: number): TurnResponseV2 => tr(ts, [
    { kind: 'message', role: 'assistant', parts: [{ kind: 'toolCall', callId: `c${ts}`, name: 'bash', args: '{"command":"ls","timeout_seconds":5}' }], reasoning: undefined },
    { kind: 'toolResult', callId: `c${ts}`, payload: '{"ok":true}', requiresFollowUp: true },
  ]);

  it('returns false when latest TR is a clean send_message (no fallback for normal exit)', () => {
    // Regression: previously walked back to find ANY historical end_turn and
    // re-evaluated that loop, falsely triggering fallback after every
    // send_message-completed cycle.
    const trs = [endTurnTr(100), sendMsgTr(110) /* old fallback */, sendMsgTr(200) /* new cycle */];
    const probes = [90, 190];
    expect(loopEndedWithoutSendMessage(trs, probes)).toBe(false);
  });

  it('returns false when latest TR is mid-loop (interrupted bash/react/etc.)', () => {
    // Interrupt path: runner break'd mid-loop. Latest TR has fwup=true tool.
    // Fallback must not fire — the next cycle will pick up the new messages.
    const trs = [endTurnTr(100), bashTr(200)];
    expect(loopEndedWithoutSendMessage(trs, [90, 190])).toBe(false);

    const trs2 = [endTurnTr(100), reactTr(200)];
    expect(loopEndedWithoutSendMessage(trs2, [90, 190])).toBe(false);
  });

  it('returns false when latest TR is end_turn but the loop included send_message', () => {
    // Loop: probe@190 → send_message@200 → end_turn@210. Already spoke; no fallback.
    const trs = [endTurnTr(100), sendMsgTr(200), endTurnTr(210)];
    expect(loopEndedWithoutSendMessage(trs, [190])).toBe(false);
  });

  it('returns true when latest TR is end_turn and the loop has no send_message', () => {
    // Loop: probe@190 → react@200 → end_turn@210. Bot acted but didn't speak.
    const trs = [endTurnTr(100), reactTr(200), endTurnTr(210)];
    expect(loopEndedWithoutSendMessage(trs, [190])).toBe(true);
  });

  it('returns false on empty trs', () => {
    expect(loopEndedWithoutSendMessage([], [])).toBe(false);
  });

  it('uses previous end_turn as loop boundary when newer than the latest probe activation', () => {
    // Two end_turn cycles back-to-back. The current loop is bounded by the
    // previous end_turn at 200, not the older probe at 50.
    const trs = [endTurnTr(200), reactTr(300), endTurnTr(310)];
    expect(loopEndedWithoutSendMessage(trs, [50])).toBe(true);
  });

  it('uses latest probe activation as loop boundary when newer than previous end_turn', () => {
    // probe@250 marks a fresh trigger AFTER the previous end_turn@100.
    // Loop = (250, 310]; only react in window → fallback.
    const trs = [endTurnTr(100), sendMsgTr(150), reactTr(300), endTurnTr(310)];
    expect(loopEndedWithoutSendMessage(trs, [50, 250])).toBe(true);
  });
});
