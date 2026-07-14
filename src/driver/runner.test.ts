import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llm/call', () => ({ callLlm: vi.fn() }));

import { createRunner } from './runner';
import { createTool } from './tools/create-tool';
import { callLlm, type LlmCallUsage } from '../llm/call';
import type { ConversationEntry } from '../unified-api/types';

initLogger(LogLevel.Error, Format.Pretty);
const logger = useLogger('runner-test');
const mockCallLlm = vi.mocked(callLlm);

const makeUsage = (
  inputTokens = 1,
  outputTokens = 1,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): LlmCallUsage => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

const toolCallEntries = (
  ...calls: { callId: string; name: string; args?: string }[]
): ConversationEntry[] => [{
  kind: 'message',
  role: 'assistant',
  parts: calls.map(call => ({
    kind: 'toolCall' as const,
    callId: call.callId,
    name: call.name,
    args: call.args ?? '{}',
  })),
  reasoning: undefined,
}];

const textEntries = (text: string): ConversationEntry[] => [{
  kind: 'message',
  role: 'assistant',
  parts: [{ kind: 'text', text }],
  reasoning: undefined,
}];

const initialEntries: ConversationEntry[] = [{
  kind: 'message',
  role: 'user',
  parts: [{ kind: 'text', text: 'start' }],
}];

const createTestRunner = () => createRunner({
  apiBaseUrl: 'mock',
  apiKey: 'key',
  model: 'mock-model',
  apiFormat: 'openai-chat',
});

beforeEach(() => {
  mockCallLlm.mockReset();
});

describe('runner step operations', () => {
  it('accumulates forced retry usage and executes only the selected model response', async () => {
    const rejectedExecute = vi.fn(() => ({ content: 'rejected', requiresFollowUp: false }));
    const selectedExecute = vi.fn(() => ({ content: 'selected', requiresFollowUp: false }));
    const rejectedTool = createTool({
      name: 'end_turn',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: rejectedExecute,
    });
    const selectedTool = createTool({
      name: 'send_message',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: selectedExecute,
    });
    const rejectedEntries = toolCallEntries({ callId: 'rejected', name: 'end_turn' });
    const selectedEntries = toolCallEntries({ callId: 'selected', name: 'send_message' });

    mockCallLlm
      .mockResolvedValueOnce({ entries: rejectedEntries, usage: makeUsage(1, 2, 3, 4) })
      .mockResolvedValueOnce({ entries: selectedEntries, usage: makeUsage(10, 20, 30, 40) });

    const runner = createTestRunner();
    const onStepComplete = vi.fn(async () => {});
    await runner.runStepLoop({
      chatId: 'operation-boundary',
      entries: initialEntries,
      system: 'system',
      tools: [rejectedTool, selectedTool],
      maxSteps: 1,
      forceToolChoice: { name: 'send_message' },
      onStepComplete,
      checkInterrupt: () => false,
      log: logger,
    });

    expect(rejectedExecute).not.toHaveBeenCalled();
    expect(selectedExecute).toHaveBeenCalledOnce();
    expect(mockCallLlm).toHaveBeenCalledTimes(2);
    expect(mockCallLlm.mock.calls.map(call => call[1])).toEqual([
      initialEntries,
      initialEntries,
    ]);
    expect(mockCallLlm.mock.calls.map(call => call[4]?.label)).toEqual(['step:1', 'step:1']);
    expect(onStepComplete).toHaveBeenCalledWith(
      [
        ...selectedEntries,
        {
          kind: 'toolResult',
          callId: 'selected',
          payload: 'selected',
          requiresFollowUp: false,
        },
      ],
      makeUsage(11, 22, 33, 44),
      expect.any(Number),
    );
  });
});

describe('runner turn loop', () => {
  it('persists empty model output with its usage', async () => {
    const usage = makeUsage(5, 0, 2, 1);
    mockCallLlm.mockResolvedValue({ entries: [], usage });
    const onStepComplete = vi.fn(async () => {});
    const checkInterrupt = vi.fn(() => true);

    await createTestRunner().runStepLoop({
      chatId: 'empty-output',
      entries: initialEntries,
      system: 'system',
      tools: [],
      maxSteps: 3,
      onStepComplete,
      checkInterrupt,
      log: logger,
    });

    expect(onStepComplete).toHaveBeenCalledOnce();
    expect(onStepComplete).toHaveBeenCalledWith([], usage, expect.any(Number));
    expect(checkInterrupt).not.toHaveBeenCalled();
    expect(mockCallLlm).toHaveBeenCalledOnce();
  });

  it('continues when any tool result requires follow-up and appends the completed step', async () => {
    const stopTool = createTool({
      name: 'stop_here',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ content: 'stopped', requiresFollowUp: false }),
    });
    const continueTool = createTool({
      name: 'continue_work',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ content: 'continuing', requiresFollowUp: true }),
    });
    const firstModelEntries = toolCallEntries(
      { callId: 'stop-1', name: 'stop_here' },
      { callId: 'continue-1', name: 'continue_work' },
    );
    const firstStepEntries: ConversationEntry[] = [
      ...firstModelEntries,
      {
        kind: 'toolResult',
        callId: 'stop-1',
        payload: 'stopped',
        requiresFollowUp: false,
      },
      {
        kind: 'toolResult',
        callId: 'continue-1',
        payload: 'continuing',
        requiresFollowUp: true,
      },
    ];
    const finalEntries = textEntries('done');
    mockCallLlm
      .mockResolvedValueOnce({ entries: firstModelEntries, usage: makeUsage(2, 3) })
      .mockResolvedValueOnce({ entries: finalEntries, usage: makeUsage(4, 5) });
    const order: string[] = [];
    const onStepComplete = vi.fn(async (
      _stepEntries: ConversationEntry[],
      _usage: LlmCallUsage,
      _requestedAtMs: number,
    ) => {
      order.push('persist');
    });
    const checkInterrupt = vi.fn(() => {
      order.push('interrupt');
      return false;
    });

    await createTestRunner().runStepLoop({
      chatId: 'follow-up',
      entries: initialEntries,
      system: 'system',
      tools: [stopTool, continueTool],
      maxSteps: 2,
      onStepComplete,
      checkInterrupt,
      log: logger,
    });

    expect(order).toEqual(['persist', 'interrupt', 'persist']);
    expect(checkInterrupt).toHaveBeenCalledOnce();
    expect(mockCallLlm).toHaveBeenCalledTimes(2);
    expect(mockCallLlm.mock.calls[1]?.[1]).toEqual([
      ...initialEntries,
      ...firstStepEntries,
    ]);
    expect(onStepComplete.mock.calls[0]?.[0]).toEqual(firstStepEntries);
    expect(onStepComplete.mock.calls[1]?.[0]).toEqual(finalEntries);
  });

  it('stops without checking interruption when no tool result requires follow-up', async () => {
    const tool = createTool({
      name: 'finish',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ content: 'finished', requiresFollowUp: false }),
    });
    mockCallLlm.mockResolvedValue({
      entries: toolCallEntries({ callId: 'finish-1', name: 'finish' }),
      usage: makeUsage(),
    });
    const onStepComplete = vi.fn(async () => {});
    const checkInterrupt = vi.fn(() => false);

    await createTestRunner().runStepLoop({
      chatId: 'no-follow-up',
      entries: initialEntries,
      system: 'system',
      tools: [tool],
      maxSteps: 3,
      onStepComplete,
      checkInterrupt,
      log: logger,
    });

    expect(onStepComplete).toHaveBeenCalledOnce();
    expect(checkInterrupt).not.toHaveBeenCalled();
    expect(mockCallLlm).toHaveBeenCalledOnce();
  });
});
