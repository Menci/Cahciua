import { describe, expect, it } from 'vitest';

import { composeContext } from './context';
import type { TRDataEntry, TurnResponse } from './types';
import type { FeatureFlags } from '../config/config';
import type { RenderedContext } from '../rendering/types';

type AnyMsg = Record<string, any>;

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

const responsesTR = (ts: number, data: unknown[], compat?: string): TurnResponse => ({
  requestedAtMs: ts,
  provider: 'responses',
  data,
  inputTokens: 0,
  outputTokens: 0,
  ...(compat ? { reasoningSignatureCompat: compat } : {}),
});

const assistantMsg = (text: string): TRDataEntry => ({ role: 'assistant', content: text });
const toolCallMsg = (id: string, name: string, args: string): TRDataEntry => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
});
const toolResultMsg = (id: string, content: string): TRDataEntry => ({
  role: 'tool',
  tool_call_id: id,
  content,
});

const flags = (overrides: Partial<FeatureFlags> = {}): FeatureFlags => ({
  trimStaleNoToolCallTurnResponses: false,
  trimSelfMessagesCoveredBySendToolCalls: false,
  trimToolResults: false,
  ...overrides,
});

describe('trimToolResults via composeContext', () => {
  const longContent = 'x'.repeat(1000);

  it('does not trim when feature flag is off', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [
      tr(200, [toolCallMsg('tc1', 'read', '{}'), toolResultMsg('tc1', longContent)]),
      tr(300, [toolCallMsg('tc2', 'read', '{}'), toolResultMsg('tc2', longContent)]),
      tr(400, [toolCallMsg('tc3', 'read', '{}'), toolResultMsg('tc3', longContent)]),
    ];

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: false }));
    expect(result).not.toBeNull();

    // All tool results should contain the full long content
    const toolResults = result!.messages.filter(m => (m as any).role === 'tool');
    for (const tr of toolResults)
      expect((tr as any).content).toBe(longContent);
  });

  it('keeps recent TRs untrimmed, trims older ones with long content', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [
      tr(200, [toolCallMsg('tc1', 'read', '{}'), toolResultMsg('tc1', longContent)]),
      tr(300, [toolCallMsg('tc2', 'read', '{}'), toolResultMsg('tc2', longContent)]),
      tr(400, [toolCallMsg('tc3', 'read', '{}'), toolResultMsg('tc3', longContent)]),
    ];

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: true }));
    expect(result).not.toBeNull();

    const toolResults = result!.messages.filter(m => (m as any).role === 'tool');
    expect(toolResults).toHaveLength(3);

    // First TR's tool result (oldest) should be trimmed
    expect((toolResults[0] as any).content).toContain('[trimmed');
    expect((toolResults[0] as any).content.length).toBeLessThan(longContent.length);

    // Last two TRs' tool results (recent) should be untrimmed
    expect((toolResults[1] as any).content).toBe(longContent);
    expect((toolResults[2] as any).content).toBe(longContent);
  });

  it('does not trim short tool results even in old TRs', () => {
    const shortContent = 'short result';
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [
      tr(200, [toolCallMsg('tc1', 'read', '{}'), toolResultMsg('tc1', shortContent)]),
      tr(300, [toolCallMsg('tc2', 'read', '{}'), toolResultMsg('tc2', longContent)]),
      tr(400, [toolCallMsg('tc3', 'read', '{}'), toolResultMsg('tc3', longContent)]),
    ];

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: true }));
    expect(result).not.toBeNull();

    const toolResults = result!.messages.filter(m => (m as any).role === 'tool');
    // First TR's short tool result should be preserved
    expect((toolResults[0] as any).content).toBe(shortContent);
  });

  it('preserves assistant entries in trimmed TRs', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [
      tr(200, [
        toolCallMsg('tc1', 'read', '{"path":"/etc"}'),
        toolResultMsg('tc1', longContent),
        assistantMsg('I read the file'),
      ]),
      tr(300, [assistantMsg('reply2')]),
      tr(400, [assistantMsg('reply3')]),
    ];

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: true }));
    expect(result).not.toBeNull();

    // The assistant entries should be preserved (4: tool_call assistant + final assistant from TR1, plus 2 from TR2/TR3)
    const assistants = result!.messages.filter(m => (m as any).role === 'assistant');
    expect(assistants).toHaveLength(4);
    expect((assistants[0] as any).tool_calls).toBeDefined();
    expect((assistants[1] as any).content).toBe('I read the file');
    expect((assistants[2] as any).content).toBe('reply2');
  });

  it('does nothing when only KEEP_RECENT TRs exist', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [
      tr(200, [toolCallMsg('tc1', 'read', '{}'), toolResultMsg('tc1', longContent)]),
      tr(300, [toolCallMsg('tc2', 'read', '{}'), toolResultMsg('tc2', longContent)]),
    ];

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: true }));
    expect(result).not.toBeNull();

    const toolResults = result!.messages.filter(m => (m as any).role === 'tool');
    // Both should be untrimmed (only 2 TRs = KEEP_RECENT)
    for (const tr of toolResults)
      expect((tr as any).content).toBe(longContent);
  });

  it('trimmed content preserves head and tail', () => {
    const content = `HEAD${  'x'.repeat(800)  }TAIL`;
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [
      tr(200, [toolCallMsg('tc1', 'read', '{}'), toolResultMsg('tc1', content)]),
      tr(300, [assistantMsg('r2')]),
      tr(400, [assistantMsg('r3')]),
    ];

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: true }));
    const toolResults = result!.messages.filter(m => (m as any).role === 'tool');
    const trimmed = (toolResults[0] as any).content as string;
    expect(trimmed).toContain('HEAD');
    expect(trimmed).toContain('TAIL');
    expect(trimmed).toContain('[trimmed');
  });
});

// ── Responses provider tests ──

describe('composeContext with responses provider TRs', () => {
  it('converts responses TR data to openai-chat messages', () => {
    const rc: RenderedContext = [textSeg(100, 'hello')];
    const trs = [responsesTR(200, [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] },
    ])];

    const result = composeContext(rc, trs, 100000, undefined);
    expect(result).not.toBeNull();

    const assistants = result!.messages.filter(m => (m as AnyMsg).role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as AnyMsg).content).toBe('hi there');
  });

  it('preserves function_call_output as tool messages', () => {
    const rc: RenderedContext = [textSeg(100, 'hello')];
    const trs = [responsesTR(200, [
      { type: 'message', role: 'assistant', content: [] },
      { type: 'function_call', call_id: 'fc1', name: 'send_message', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'fc1', output: '{"ok":true}' },
    ])];

    const result = composeContext(rc, trs, 100000, undefined);
    expect(result).not.toBeNull();

    const toolMsgs = result!.messages.filter(m => (m as AnyMsg).role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    expect((toolMsgs[0] as AnyMsg).tool_call_id).toBe('fc1');
    expect((toolMsgs[0] as AnyMsg).content).toBe('{"ok":true}');
  });

  it('preserves reasoning when compat matches', () => {
    const rc: RenderedContext = [textSeg(100, 'hello')];
    const trs = [responsesTR(200, [
      { type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: 'thinking' }], encrypted_content: 'sig_abc' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ], 'anthropic')];

    const result = composeContext(rc, trs, 100000, 'anthropic');
    expect(result).not.toBeNull();

    const assistants = result!.messages.filter(m => (m as AnyMsg).role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as AnyMsg).reasoning_opaque).toBe('sig_abc');
    expect((assistants[0] as AnyMsg).reasoning_text).toBe('thinking');
  });

  it('strips reasoning when compat mismatches', () => {
    const rc: RenderedContext = [textSeg(100, 'hello')];
    const trs = [responsesTR(200, [
      { type: 'reasoning', id: 'rs1', summary: [], encrypted_content: 'sig_abc' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ], 'anthropic')];

    const result = composeContext(rc, trs, 100000, 'openai');
    expect(result).not.toBeNull();

    const assistants = result!.messages.filter(m => (m as AnyMsg).role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as AnyMsg).reasoning_opaque).toBeUndefined();
  });

  it('trHasToolCalls detects function_call items in responses TRs', () => {
    const rc: RenderedContext = [textSeg(100, 'hello')];
    const trsWithToolCalls = [
      responsesTR(200, [{ type: 'function_call', call_id: 'fc1', name: 'fn', arguments: '{}', status: 'completed' }]),
      responsesTR(300, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'text only' }] }]),
    ];

    const result = composeContext(rc, trsWithToolCalls, 100000, undefined, flags({ trimStaleNoToolCallTurnResponses: true }));
    expect(result).not.toBeNull();
    // Both TRs should survive — only 2 total, and the no-tool-call one is kept (< KEEP_NO_TOOL_CALL_TRS)
    const assistants = result!.messages.filter(m => (m as AnyMsg).role === 'assistant');
    expect(assistants.length).toBeGreaterThanOrEqual(1);
  });

  it('trimToolResults trims function_call_output in responses TRs', () => {
    const longOutput = 'x'.repeat(1000);
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [
      responsesTR(200, [
        { type: 'function_call', call_id: 'fc1', name: 'fn', arguments: '{}', status: 'completed' },
        { type: 'function_call_output', call_id: 'fc1', output: longOutput },
      ]),
      responsesTR(300, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'r2' }] }]),
      responsesTR(400, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'r3' }] }]),
    ];

    const result = composeContext(rc, trs, 100000, undefined, flags({ trimToolResults: true }));
    expect(result).not.toBeNull();

    const toolMsgs = result!.messages.filter(m => (m as AnyMsg).role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    // Oldest TR's tool result should be trimmed
    expect((toolMsgs[0] as AnyMsg).content).toContain('[trimmed');
  });

  it('handles mixed openai-chat and responses TRs', () => {
    const rc: RenderedContext = [textSeg(100, 'hello')];
    const trs = [
      tr(200, [assistantMsg('from chat')]),
      responsesTR(300, [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'from responses' }] },
      ]),
    ];

    const result = composeContext(rc, trs, 100000, undefined);
    expect(result).not.toBeNull();

    const assistants = result!.messages.filter(m => (m as AnyMsg).role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect((assistants[0] as AnyMsg).content).toBe('from chat');
    expect((assistants[1] as AnyMsg).content).toBe('from responses');
  });
});
