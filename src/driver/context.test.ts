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
  // TR helpers — fwup state of the toolResult is what defines loop membership.
  // sendMsg / end_turn → fwup=false (clean exit / loop boundary).
  // react / bash → fwup=true (continuation; runner planned a next step).
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
  // Step that emits send_message + a fwup=true tool in parallel (so the runner
  // continues to the next step). Models the user's t+80 hypothetical: bot
  // speaks AND queues another action in the same step.
  const sendMsgPlusBashTr = (ts: number): TurnResponseV2 => tr(ts, [
    {
      kind: 'message', role: 'assistant', parts: [
        { kind: 'toolCall', callId: `c${ts}a`, name: 'send_message', args: '{"text":"hi"}' },
        { kind: 'toolCall', callId: `c${ts}b`, name: 'bash', args: '{"command":"ls","timeout_seconds":5}' },
      ], reasoning: undefined,
    },
    { kind: 'toolResult', callId: `c${ts}a`, payload: '{"ok":true}', requiresFollowUp: false },
    { kind: 'toolResult', callId: `c${ts}b`, payload: '{"ok":true}', requiresFollowUp: true },
  ]);

  it('returns false when latest TR is a clean send_message (no fallback for normal exit)', () => {
    // Gate: cycle exited via send_message, not end_turn.
    const trs = [endTurnTr(100), sendMsgTr(110), sendMsgTr(200)];
    expect(loopEndedWithoutSendMessage(trs)).toBe(false);
  });

  it('returns false when latest TR is mid-loop (interrupted bash/react/etc.)', () => {
    // Interrupt path: runner broke mid-loop. Latest TR has fwup=true tool.
    // Gate skips fallback — the next cycle will pick up the new messages.
    expect(loopEndedWithoutSendMessage([endTurnTr(100), bashTr(200)])).toBe(false);
    expect(loopEndedWithoutSendMessage([endTurnTr(100), reactTr(200)])).toBe(false);
  });

  it('returns false when the current cycle includes send_message (clean exit)', () => {
    // Multi-step: send_message → react → end_turn (all in one runStepLoop).
    // The send_message + bash step has fwup=true (bash) → walk-back continues
    // and finds the send_message. No fallback.
    const trs = [endTurnTr(100), sendMsgPlusBashTr(200), reactTr(210), endTurnTr(220)];
    expect(loopEndedWithoutSendMessage(trs)).toBe(false);
  });

  it('returns true when current cycle ends with end_turn and has no send_message', () => {
    // Bot acted (react) but never spoke. Fallback fires.
    const trs = [endTurnTr(100), reactTr(200), endTurnTr(210)];
    expect(loopEndedWithoutSendMessage(trs)).toBe(true);
  });

  it('returns true when prior cycle exited via clean send_message (different loop)', () => {
    // Cycle Y case. Previous cycle (X2) exited cleanly via send_message
    // (fwup=false). Cycle Y is a new trigger (mention/replied) — its loop
    // does not include cycle X2's send_message. Walk-back stops at the
    // clean exit boundary; current loop = react + end_turn only → fallback.
    const trs = [sendMsgTr(100) /* cycle X2 */, reactTr(200) /* cycle Y */, endTurnTr(210)];
    expect(loopEndedWithoutSendMessage(trs)).toBe(true);
  });

  it('returns false when interrupted continuation chains across cycles with send_message earlier', () => {
    // t+80 hypothetical: cycle A1 step had send_message + bash (fwup=true).
    // Cycle resumed via interrupt, kept reacting, eventually end_turn'd.
    // Walk-back crosses the fwup=true chain and finds A1's send_message.
    const trs = [
      sendMsgPlusBashTr(80),  // cycle A1 step 1: send_message+bash, interrupted before next step
      reactTr(160),           // cycle A1 (or B's continuation) step
      endTurnTr(180),
    ];
    expect(loopEndedWithoutSendMessage(trs)).toBe(false);
  });

  it('returns false on empty trs', () => {
    expect(loopEndedWithoutSendMessage([])).toBe(false);
  });

  it('returns true for sleep-loop-without-speaking ended via end_turn', () => {
    // The original use case for fallback — bot kept doing fwup=true tools
    // (sleep / react / etc.) without ever sending a message, then end_turn'd.
    const trs = [
      sendMsgTr(50),    // earlier cycle, clean exit (different loop boundary)
      reactTr(100),     // current loop: react
      reactTr(110),     // react again
      endTurnTr(120),
    ];
    expect(loopEndedWithoutSendMessage(trs)).toBe(true);
  });

  it('returns true even with stale historical end_turn TRs in trs', () => {
    // Regression: the old logic would walk back to the most recent end_turn
    // anywhere in history and re-evaluate THAT loop. Now we only look at the
    // current cycle's chain — historical end_turn TRs are simply clean exits
    // that bound earlier loops.
    const trs = [
      endTurnTr(50),    // historical end_turn (some old loop's end)
      sendMsgTr(60),    // historical fallback
      sendMsgTr(70),    // some other old send
      reactTr(200),     // current loop
      endTurnTr(210),
    ];
    expect(loopEndedWithoutSendMessage(trs)).toBe(true);
  });
});
