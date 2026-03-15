import { describe, expect, it } from 'vitest';

import { composeContext } from './context';
import type { TRDataEntry, TurnResponse } from './types';
import type { FeatureFlags } from '../config/config';
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
