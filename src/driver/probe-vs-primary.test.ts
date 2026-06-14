import { useGlobalLogger, useLogger } from '@guiiai/logg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./call-llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./call-llm')>();
  return {
    ...actual,
    callLlm: vi.fn(),
  };
});

import { callLlm } from './call-llm';
import { createDriver } from './index';
import type { TurnResponseV2 } from './types';
import type { ResolvedChatConfig } from '../config/config';
import type { RenderedContext } from '../rendering/types';
import type { ConversationEntry } from '../unified-api/types';

useGlobalLogger({ level: 'log', mode: 'pretty' });
const logger = useLogger('probe-vs-primary-test');

const mockCallLlm = vi.mocked(callLlm);

const makeChatConfig = (): ResolvedChatConfig => ({
  primary: {
    model: { apiBaseUrl: 'mock', apiKey: 'k', model: 'mock-primary', apiFormat: 'openai-chat' },
    apiFormat: 'openai-chat',
    forceToolCall: false,
  },
  systemFiles: [],
  sendTypingAction: false,
  debounce: { initialDelayMs: 1, typingExtendMs: 1, maxDelayMs: 50 },
  compaction: { maxContextEstTokens: 200000, workingWindowEstTokens: 8000 },
  probe: {
    model: { apiBaseUrl: 'mock', apiKey: 'k', model: 'mock-probe', apiFormat: 'openai-chat' },
    forceToolCall: false,
  },
  imageToText: { enabled: false, maxConcurrency: 1 },
  animationToText: { enabled: false, maxFrames: 0, maxConcurrency: 1 },
  customEmojiToText: { enabled: false, maxFrames: 0, maxConcurrency: 1 },
  tools: { bash: { backgroundThresholdSec: 10 } },
});

const buildRC = (): RenderedContext => [
  {
    receivedAtMs: 1000,
    senderId: 'user1',
    content: [{ type: 'text', text: '<message id="1" sender="Alice (@alice)" t="2025-01-01T00:00:01+00:00">hello bot</message>' }],
  },
  {
    receivedAtMs: 2000,
    senderId: 'bot',
    isMyself: true,
    isSelfSent: true,
    content: [{ type: 'text', text: '<message id="2" sender="Bot (@bot)" myself="true" t="2025-01-01T00:00:02+00:00">hi alice</message>' }],
  },
  {
    receivedAtMs: 3000,
    senderId: 'user1',
    content: [{ type: 'text', text: '<message id="3" sender="Alice (@alice)" t="2025-01-01T00:00:03+00:00">how are you?</message>' }],
  },
];

const buildTRs = (): TurnResponseV2[] => [{
  requestedAtMs: 2000,
  modelName: 'mock-primary',
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  entries: [
    {
      kind: 'message',
      role: 'assistant',
      parts: [{ kind: 'toolCall', callId: 'call1', name: 'send_message', args: JSON.stringify({ text: 'hi alice' }) }],
      reasoning: undefined,
    },
    {
      kind: 'toolResult',
      callId: 'call1',
      payload: JSON.stringify({ ok: true, message_id: '2' }),
      requiresFollowUp: false,
    },
  ],
}];

const collectUserText = (entries: ConversationEntry[]): string =>
  entries.flatMap(e =>
    e.kind === 'message' && e.role === 'user'
      ? e.parts.flatMap(p => p.kind === 'text' ? [p.text] : [])
      : [],
  ).join('\n');

const collectAssistantToolCallNames = (entries: ConversationEntry[]): string[] =>
  entries.flatMap(e =>
    e.kind === 'message' && e.role === 'assistant'
      ? e.parts.flatMap(p => p.kind === 'toolCall' ? [p.name] : [])
      : [],
  );

describe('probe vs primary view of bot\'s own messages', () => {
  it('probe sees bot xml in chat history; primary sees only the assistant tool call', async () => {
    mockCallLlm.mockReset();

    mockCallLlm.mockImplementation(async (config, _entries) => {
      if (config.model === 'mock-probe') {
        const out: ConversationEntry[] = [{
          kind: 'message',
          role: 'assistant',
          parts: [{
            kind: 'toolCall',
            callId: 'probe1',
            name: 'decide',
            args: JSON.stringify({ should_act: true, reason: 'directly addressed by user' }),
          }],
          reasoning: undefined,
        }];
        return { entries: out, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      }
      // primary: text-only response — no tool calls so the runner exits cleanly.
      const out: ConversationEntry[] = [{
        kind: 'message',
        role: 'assistant',
        parts: [{ kind: 'text', text: 'I am fine, thanks!' }],
        reasoning: undefined,
      }];
      return { entries: out, usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    });

    const trs = buildTRs();
    const persistedTRs: TurnResponseV2[] = [];

    const driver = createDriver(
      { chatIds: ['-100123'], resolveChatConfig: () => makeChatConfig() },
      {
        loadTurnResponses: async () => [...trs, ...persistedTRs],
        persistTurnResponse: async (_, tr) => { persistedTRs.push(tr); },
        persistProbeResponse: async () => {},
        sendMessage: async () => ({ messageId: 999, date: 0 }),
        setMessageReaction: async () => {},
        loadCompaction: () => null,
        loadLastProbeTime: () => 0,
        persistCompaction: () => {},
        setCompactCursor: () => undefined,
        getChatTitle: () => 'Test',
        runtimeConfig: { shell: ['/bin/bash', '-c'], writeFile: ['cat'], readFile: ['cat'], writeFileSizeLimit: 1024, readFileSizeLimit: 1024 },
        loadMessageAttachments: () => undefined,
        messageExists: () => true,
        downloadMessageMedia: async () => undefined,
        resolveModel: () => ({ apiBaseUrl: 'mock', apiKey: 'k', model: 'mock' }),
        backgroundTask: {
          startTask: () => 0,
          killTask: () => ({ ok: true }),
          getActiveTasks: () => [],
          readTaskOutput: async () => ({ content: '', totalLines: 0, truncated: false }),
        },
        logger,
      },
    );

    driver.handleEvent('-100123', buildRC());

    // Wait for the debounce + probe + primary to play out.
    await vi.waitFor(() => expect(mockCallLlm).toHaveBeenCalledTimes(2), { timeout: 1000, interval: 10 });

    const calls = mockCallLlm.mock.calls;
    const probeCall = calls.find(c => c[0]!.model === 'mock-probe');
    const primaryCall = calls.find(c => c[0]!.model === 'mock-primary');
    expect(probeCall).toBeDefined();
    expect(primaryCall).toBeDefined();

    const probeUserText = collectUserText(probeCall![1]);
    const primaryUserText = collectUserText(primaryCall![1]);

    // Probe sees the bot's outgoing message as an XML <message> with myself="true".
    expect(probeUserText).toContain('myself="true"');
    expect(probeUserText).toContain('hi alice');
    expect(probeUserText).toContain('hello bot');
    expect(probeUserText).toContain('how are you?');

    // Primary does NOT see the bot's outgoing message as user-side XML.
    expect(primaryUserText).not.toContain('myself="true"');
    expect(primaryUserText).not.toContain('hi alice');
    expect(primaryUserText).toContain('hello bot');
    expect(primaryUserText).toContain('how are you?');

    // Primary DOES see the assistant's send_message tool call.
    const primaryAssistantToolCalls = collectAssistantToolCallNames(primaryCall![1]);
    expect(primaryAssistantToolCalls).toContain('send_message');

    // Probe sees no assistant tool calls in its context (all TRs stripped).
    const probeAssistantToolCalls = collectAssistantToolCallNames(probeCall![1]);
    expect(probeAssistantToolCalls).toEqual([]);

    driver.stop();
  });
});
