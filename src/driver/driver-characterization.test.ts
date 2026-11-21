import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llm/call', () => ({ callLlm: vi.fn() }));

import { createDriver } from './index';
import { createRunner } from './runner';
import { createTool } from './tools/create-tool';
import type { ProbeResponseV2, TurnResponseV2 } from './types';
import type { ResolvedChatConfig } from '../config/config';
import type { LlmCallUsage } from '../llm/call';
import { callLlm } from '../llm/call';
import type { RenderedContext } from '../rendering/types';
import type { ConversationEntry } from '../unified-api/types';

initLogger(LogLevel.Error, Format.Pretty);
const logger = useLogger('driver-characterization-test');
const mockCallLlm = vi.mocked(callLlm);

const makeUsage = (
  inputTokens = 1,
  outputTokens = 1,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): LlmCallUsage => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

const toolCallEntries = (callId: string, name: string, args = '{}'): ConversationEntry[] => [{
  kind: 'message',
  role: 'assistant',
  parts: [{ kind: 'toolCall', callId, name, args }],
  reasoning: undefined,
}];

const makeChatConfig = (): ResolvedChatConfig => ({
  primary: {
    model: { apiBaseUrl: 'mock', apiKey: 'key', model: 'mock-primary', apiFormat: 'openai-chat' },
  },
  systemFiles: [],
  sendTypingAction: false,
  blockedUserIds: [],
  debounce: { initialDelayMs: 1, typingExtendMs: 1, maxDelayMs: 50 },
  compaction: { maxContextEstTokens: 200000, workingWindowEstTokens: 8000 },
  probe: {
    model: { apiBaseUrl: 'mock', apiKey: 'key', model: 'mock-probe', apiFormat: 'openai-chat' },
  },
  imageToText: { enabled: false, maxConcurrency: 1 },
  animationToText: { enabled: false, maxFrames: 0, maxConcurrency: 1 },
  customEmojiToText: { enabled: false, maxFrames: 0, maxConcurrency: 1 },
  tools: { banSpammer: false, bash: { backgroundThresholdSec: 10 } },
});

const buildExternalContext = (receivedAtMs = 1000): RenderedContext => [{
  receivedAtMs,
  senderId: 'user-1',
  content: [{
    type: 'text',
    text: '<message id="1" sender="Alice (@alice)" t="2025-01-01T00:00:01+00:00">hello bot</message>',
  }],
}];

type DriverDeps = Parameters<typeof createDriver>[1];

const makeDriverDeps = (overrides: Partial<DriverDeps> = {}): DriverDeps => ({
  loadTurnResponses: async () => [],
  persistTurnResponse: async () => {},
  persistProbeResponse: async () => {},
  loadLastActivatedProbe: async () => null,
  sendMessage: async () => ({ messageId: 1, date: 0 }),
  banSpammer: async () => ({ status: 'rejected' as const, reason: 'unknown_message' as const }),
  setMessageReaction: async () => {},
  sendTypingAction: async () => {},
  onDebounceStateChange: () => {},
  loadCompaction: () => null,
  loadLastProbeTime: () => 0,
  persistCompaction: () => {},
  setCompactCursor: () => [],
  getChatTitle: () => 'Test chat',
  runtimeConfig: {
    shell: ['/bin/bash', '-c'],
    writeFile: ['cat'],
    readFile: ['cat'],
    writeFileSizeLimit: 1024,
    readFileSizeLimit: 1024,
  },
  loadMessageAttachments: () => undefined,
  messageExists: () => true,
  downloadMessageMedia: async () => undefined,
  readOldMessages: () => '',
  resolveModel: () => ({ apiBaseUrl: 'mock', apiKey: 'key', model: 'mock', apiFormat: 'openai-chat' }),
  backgroundTask: {
    startTask: () => 0,
    killTask: () => ({ ok: true }),
    getActiveTasks: () => [],
    readTaskOutput: async () => ({ content: '', totalLines: 0, truncated: false }),
  },
  logger,
  ...overrides,
});

const activeDrivers: ReturnType<typeof createDriver>[] = [];

const startDriver = (
  chatId: string,
  deps: DriverDeps,
  configOverrides: Partial<ResolvedChatConfig> = {},
) => {
  const driver = createDriver({
    chatIds: [chatId],
    resolveChatConfig: () => ({ ...makeChatConfig(), ...configOverrides }),
  }, deps);
  activeDrivers.push(driver);
  return driver;
};

beforeEach(() => {
  mockCallLlm.mockReset();
});

afterEach(() => {
  for (const driver of activeDrivers) driver.stop();
  activeDrivers.length = 0;
});

describe('Driver probe gate characterization', () => {
  const failClosedCases: { name: string; entries: ConversationEntry[] }[] = [
    {
      name: 'no decide call',
      entries: [{
        kind: 'message',
        role: 'assistant',
        parts: [{ kind: 'text', text: 'I would answer.' }],
        reasoning: undefined,
      }],
    },
    {
      name: 'invalid decide arguments',
      entries: toolCallEntries('probe-invalid', 'decide', JSON.stringify({ should_act: 'send_message' })),
    },
  ];

  it.each(failClosedCases)('fails closed on $name and persists the rejected probe', async ({ entries }) => {
    const persistedProbes: ProbeResponseV2[] = [];
    const persistedTurns: TurnResponseV2[] = [];
    const sendMessage = vi.fn(async () => ({ messageId: 1, date: 0 }));
    const probeUsage = makeUsage(11, 7, 3, 2);
    mockCallLlm.mockResolvedValue({ entries, usage: probeUsage });

    const driver = startDriver('probe-fail-closed', makeDriverDeps({
      persistProbeResponse: async (_chatId, probe) => { persistedProbes.push(probe); },
      persistTurnResponse: async (_chatId, turn) => { persistedTurns.push(turn); },
      sendMessage,
    }));

    driver.handleEvent('probe-fail-closed', buildExternalContext());

    await vi.waitFor(() => expect(persistedProbes).toHaveLength(1), { timeout: 2000 });

    expect(mockCallLlm).toHaveBeenCalledTimes(1);
    expect(mockCallLlm.mock.calls[0]![0]).toMatchObject({
      model: 'mock-probe',
      forceToolChoice: { name: 'decide' },
    });
    expect(persistedProbes[0]).toMatchObject({
      entries,
      ...probeUsage,
      modelName: 'mock-probe',
      isActivated: false,
    });
    expect(persistedTurns).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('persists no_action and advances the watermark without invoking primary', async () => {
    const entries = toolCallEntries('probe-no-action', 'decide', JSON.stringify({
      should_act: 'no_action',
      reason: 'The exchange is already complete.',
    }));
    const probeUsage = makeUsage(13, 5, 2, 0);
    const persistedProbes: ProbeResponseV2[] = [];
    const persistedTurns: TurnResponseV2[] = [];
    const onDebounceStateChange = vi.fn();
    let probePersisted = false;
    let loadsAfterProbePersistence = 0;

    mockCallLlm.mockResolvedValue({ entries, usage: probeUsage });

    const driver = startDriver('probe-no-action', makeDriverDeps({
      loadTurnResponses: async () => {
        if (probePersisted) loadsAfterProbePersistence++;
        return persistedTurns;
      },
      persistProbeResponse: async (_chatId, probe) => {
        persistedProbes.push(probe);
        probePersisted = true;
      },
      persistTurnResponse: async (_chatId, turn) => { persistedTurns.push(turn); },
      onDebounceStateChange,
    }));

    driver.handleEvent('probe-no-action', buildExternalContext());

    await vi.waitFor(() => expect(persistedProbes).toHaveLength(1), { timeout: 2000 });
    await vi.waitFor(() => expect(loadsAfterProbePersistence).toBeGreaterThan(0), { timeout: 2000 });

    expect(mockCallLlm).toHaveBeenCalledTimes(1);
    expect(persistedProbes[0]).toMatchObject({
      entries,
      ...probeUsage,
      modelName: 'mock-probe',
      isActivated: false,
    });
    expect(persistedTurns).toEqual([]);

    await new Promise<void>(resolve => setImmediate(resolve));
    onDebounceStateChange.mockClear();
    mockCallLlm.mockClear();

    driver.handleEvent(
      'probe-no-action',
      buildExternalContext(persistedProbes[0]!.requestedAtMs),
    );

    await new Promise<void>(resolve => setTimeout(resolve, 25));
    expect(onDebounceStateChange).not.toHaveBeenCalled();
    expect(mockCallLlm).not.toHaveBeenCalled();
    expect(persistedProbes).toHaveLength(1);
  });

  it('wakes primary on decide="any" with typing and forced any-tool choice without requiring send_message', async () => {
    const persistedProbes: ProbeResponseV2[] = [];
    const persistedTurns: TurnResponseV2[] = [];
    const sendTypingAction = vi.fn(async () => {});
    const sendMessage = vi.fn(async () => ({ messageId: 1, date: 0 }));
    const banSpammer = vi.fn(async () => ({
      status: 'completed' as const,
      userId: '456',
      ban: { status: 'banned' as const },
      deletion: {
        deletedMessageIds: [1],
        unavailableMessageIds: [],
        notDeletableMessageIds: [],
        failedMessageIds: [],
      },
    }));

    let primaryStep = 0;
    mockCallLlm.mockImplementation(async config => {
      if (config.model === 'mock-probe') {
        return {
          entries: toolCallEntries('probe-any', 'decide', JSON.stringify({
            should_act: 'any',
            reason: 'Message 1 is one-off spam; remove silently.',
          })),
          usage: makeUsage(10, 4),
        };
      }
      primaryStep++;
      if (primaryStep === 1) {
        return {
          entries: toolCallEntries('ban-1', 'ban_spammer', JSON.stringify({
            message_id: '1',
            reason: 'crypto solicitation',
          })),
          usage: makeUsage(20, 8),
        };
      }
      return {
        entries: toolCallEntries('end-1', 'end_turn', '{}'),
        usage: makeUsage(22, 4),
      };
    });

    const base = makeChatConfig();
    const driver = startDriver(
      '-100777',
      makeDriverDeps({
        loadTurnResponses: async () => [...persistedTurns],
        persistTurnResponse: async (_chatId, turn) => { persistedTurns.push(turn); },
        persistProbeResponse: async (_chatId, probe) => { persistedProbes.push(probe); },
        loadLastActivatedProbe: async () => persistedProbes.findLast(p => p.isActivated) ?? null,
        sendTypingAction,
        sendMessage,
        banSpammer,
      }),
      {
        sendTypingAction: true,
        tools: { ...base.tools, banSpammer: true },
      },
    );

    driver.handleEvent('-100777', buildExternalContext());

    // 1 probe + 2 primary steps (ban_spammer -> end_turn), and NO forced send_message fallback.
    await vi.waitFor(() => expect(persistedTurns).toHaveLength(2), { timeout: 2000 });
    await new Promise<void>(resolve => setTimeout(resolve, 50));

    expect(mockCallLlm).toHaveBeenCalledTimes(3);
    expect(persistedProbes[0]).toMatchObject({ isActivated: true });
    expect(sendTypingAction).toHaveBeenCalledWith('-100777');
    expect(banSpammer).toHaveBeenCalledExactlyOnceWith('-100777', 1);
    expect(mockCallLlm.mock.calls[1]![0].forceToolChoice).toBe('any');
    expect(mockCallLlm.mock.calls[2]![0].forceToolChoice).toBe('any');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('preserves decide="any" across a cooperative interruption so continuation still omits forced send_message', async () => {
    const persistedProbes: ProbeResponseV2[] = [];
    const persistedTurns: TurnResponseV2[] = [];
    const sendMessage = vi.fn(async () => ({ messageId: 1, date: 0 }));

    let primaryCalls = 0;
    mockCallLlm.mockImplementation(async config => {
      if (config.model === 'mock-probe') {
        return {
          entries: toolCallEntries('probe-any-int', 'decide', JSON.stringify({
            should_act: 'any',
            reason: 'Silent reaction or moderation.',
          })),
          usage: makeUsage(9, 3),
        };
      }
      primaryCalls++;
      if (primaryCalls === 1) {
        await new Promise<void>(resolve => setTimeout(resolve, 5));
        return {
          entries: toolCallEntries('react-1', 'react', JSON.stringify({
            message_id: '1',
            emoji: '👍',
          })),
          usage: makeUsage(15, 5),
        };
      }
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      return {
        entries: toolCallEntries('end-after-int', 'end_turn', '{}'),
        usage: makeUsage(18, 4),
      };
    });

    const driver = startDriver('-100778', makeDriverDeps({
      loadTurnResponses: async () => [...persistedTurns],
      persistTurnResponse: async (_chatId, turn) => {
        persistedTurns.push(turn);
        // Simulate a new external message arriving after step 1 was requested
        // (turn.requestedAtMs + 1) and before the continuation step starts.
        if (persistedTurns.length === 1) {
          driver.handleEvent('-100778', [
            ...buildExternalContext(1000),
            ...buildExternalContext(turn.requestedAtMs + 1),
          ]);
        }
      },
      persistProbeResponse: async (_chatId, probe) => { persistedProbes.push(probe); },
      loadLastActivatedProbe: async () => persistedProbes.findLast(p => p.isActivated) ?? null,
      sendMessage,
    }));

    driver.handleEvent('-100778', buildExternalContext(1000));

    // 1 initial probe + step 1 (react, interrupted) + continuation step 1 (end_turn,probe skipped) = 3 LLM calls, 0 fallback.
    await vi.waitFor(() => expect(persistedTurns).toHaveLength(2), { timeout: 2000 });
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    expect(persistedProbes).toHaveLength(1);
    expect(mockCallLlm).toHaveBeenCalledTimes(3);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('Runner persistence and force-tool characterization', () => {
  const createTestRunner = () => createRunner({
    apiBaseUrl: 'mock',
    apiKey: 'key',
    model: 'mock-primary',
    apiFormat: 'openai-chat',
  });

  const initialEntries: ConversationEntry[] = [{
    kind: 'message',
    role: 'user',
    parts: [{ kind: 'text', text: 'continue' }],
  }];

  it('checks a cooperative interrupt only after the completed step is persisted', async () => {
    const order: string[] = [];
    let resolvePersistence!: () => void;
    const persistence = new Promise<void>(resolve => { resolvePersistence = resolve; });
    const continuationTool = createTool({
      name: 'continue_work',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        order.push('tool');
        return { content: 'continue', requiresFollowUp: true };
      },
    });
    const modelEntries = toolCallEntries('continue-1', 'continue_work');
    const usage = makeUsage(8, 3);
    mockCallLlm.mockResolvedValue({ entries: modelEntries, usage });

    const onStepComplete = vi.fn(async (
      _stepEntries: ConversationEntry[],
      _usage: LlmCallUsage,
      _requestedAtMs: number,
    ) => {
      order.push('persist:start');
      await persistence;
      order.push('persist:end');
    });
    const checkInterrupt = vi.fn(() => {
      order.push('interrupt');
      return true;
    });

    const runPromise = createTestRunner().runStepLoop({
      chatId: 'interrupt-order',
      entries: initialEntries,
      system: 'system',
      tools: [continuationTool],
      maxSteps: 2,
      onStepComplete,
      checkInterrupt,
      log: logger,
    });

    await vi.waitFor(() => expect(onStepComplete).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['tool', 'persist:start']);
    expect(checkInterrupt).not.toHaveBeenCalled();

    resolvePersistence();
    await runPromise;

    expect(order).toEqual(['tool', 'persist:start', 'persist:end', 'interrupt']);
    expect(checkInterrupt).toHaveBeenCalledTimes(1);
    expect(mockCallLlm).toHaveBeenCalledTimes(1);
    expect(onStepComplete.mock.calls[0]![0]).toEqual([
      ...modelEntries,
      {
        kind: 'toolResult',
        callId: 'continue-1',
        payload: 'continue',
        requiresFollowUp: true,
      },
    ]);
  });

  it('retries a named force-tool choice without executing or persisting rejected attempts', async () => {
    const rejectedExecute = vi.fn(() => ({ content: 'ended', requiresFollowUp: false }));
    const sendExecute = vi.fn(() => ({ content: 'sent', requiresFollowUp: false }));
    const rejectedTool = createTool({
      name: 'end_turn',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: rejectedExecute,
    });
    const sendTool = createTool({
      name: 'send_message',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: sendExecute,
    });
    const rejectedEntries = toolCallEntries('rejected-1', 'end_turn');
    const acceptedEntries = toolCallEntries('accepted-1', 'send_message');
    mockCallLlm
      .mockResolvedValueOnce({ entries: rejectedEntries, usage: makeUsage(1, 2, 3, 4) })
      .mockResolvedValueOnce({ entries: acceptedEntries, usage: makeUsage(10, 20, 30, 40) });
    const onStepComplete = vi.fn(async (
      _stepEntries: ConversationEntry[],
      _usage: LlmCallUsage,
      _requestedAtMs: number,
    ) => {});
    const checkInterrupt = vi.fn(() => false);

    await createTestRunner().runStepLoop({
      chatId: 'named-force-tool',
      entries: initialEntries,
      system: 'system',
      tools: [rejectedTool, sendTool],
      maxSteps: 1,
      forceToolChoice: { name: 'send_message' },
      onStepComplete,
      checkInterrupt,
      log: logger,
    });

    expect(mockCallLlm).toHaveBeenCalledTimes(2);
    expect(mockCallLlm.mock.calls.map(call => call[0].forceToolChoice)).toEqual([
      { name: 'send_message' },
      { name: 'send_message' },
    ]);
    expect(mockCallLlm.mock.calls.map(call => call[1])).toEqual([
      initialEntries,
      initialEntries,
    ]);
    expect(rejectedExecute).not.toHaveBeenCalled();
    expect(sendExecute).toHaveBeenCalledTimes(1);
    expect(onStepComplete).toHaveBeenCalledTimes(1);
    expect(onStepComplete.mock.calls[0]![0]).toEqual([
      ...acceptedEntries,
      {
        kind: 'toolResult',
        callId: 'accepted-1',
        payload: 'sent',
        requiresFollowUp: false,
      },
    ]);
    expect(onStepComplete.mock.calls[0]![1]).toEqual(makeUsage(11, 22, 33, 44));
    expect(checkInterrupt).not.toHaveBeenCalled();
  });

  it('fails without executing or persisting after force-tool retries are exhausted', async () => {
    const rejectedExecute = vi.fn((_input: unknown) => ({ content: 'wrong tool', requiresFollowUp: false }));
    const sendExecute = vi.fn(() => ({ content: 'sent', requiresFollowUp: false }));
    const rejectedTool = createTool({
      name: 'end_turn',
      description: 'Test tool.',
      parameters: {
        type: 'object',
        properties: { attempt: { type: 'number' } },
        required: ['attempt'],
      },
      execute: rejectedExecute,
    });
    const sendTool = createTool({
      name: 'send_message',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: sendExecute,
    });
    let attempt = 0;
    mockCallLlm.mockImplementation(async () => {
      attempt++;
      return {
        entries: toolCallEntries(`rejected-${attempt}`, 'end_turn', JSON.stringify({ attempt })),
        usage: makeUsage(1, 1, 1, 1),
      };
    });
    const onStepComplete = vi.fn(async (
      _stepEntries: ConversationEntry[],
      _usage: LlmCallUsage,
      _requestedAtMs: number,
    ) => {});

    await expect(createTestRunner().runStepLoop({
      chatId: 'exhausted-force-tool',
      entries: initialEntries,
      system: 'system',
      tools: [rejectedTool, sendTool],
      maxSteps: 1,
      forceToolChoice: { name: 'send_message' },
      onStepComplete,
      checkInterrupt: () => false,
      log: logger,
    })).rejects.toThrow('did not satisfy forced tool choice');

    expect(mockCallLlm).toHaveBeenCalledTimes(4);
    expect(rejectedExecute).not.toHaveBeenCalled();
    expect(sendExecute).not.toHaveBeenCalled();
    expect(onStepComplete).not.toHaveBeenCalled();
  });

  it('skips force-tool retry enforcement when callLlm reports forceApplied=false', async () => {
    const plainText: ConversationEntry[] = [{
      kind: 'message',
      role: 'assistant',
      parts: [{ kind: 'text', text: 'unforced reply' }],
      reasoning: undefined,
    }];
    mockCallLlm.mockResolvedValue({
      entries: plainText,
      usage: makeUsage(4, 6),
      forceApplied: false,
    });
    const onStepComplete = vi.fn(async () => {});

    await createTestRunner().runStepLoop({
      chatId: 'unforced-model',
      entries: initialEntries,
      system: 'system',
      tools: [],
      maxSteps: 1,
      forceToolChoice: 'any',
      onStepComplete,
      checkInterrupt: () => false,
      log: logger,
    });

    expect(mockCallLlm).toHaveBeenCalledTimes(1);
    expect(onStepComplete).toHaveBeenCalledTimes(1);
  });
});
