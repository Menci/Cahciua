import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
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

initLogger(LogLevel.Log, Format.Pretty);
const logger = useLogger('probe-vs-primary-test');

const mockCallLlm = vi.mocked(callLlm);

const makeChatConfig = (): ResolvedChatConfig => ({
  primary: {
    model: { apiBaseUrl: 'mock', apiKey: 'k', model: 'mock-primary', apiFormat: 'openai-chat' },
    apiFormat: 'openai-chat',
  },
  systemFiles: [],
  sendTypingAction: false,
  debounce: { initialDelayMs: 1, typingExtendMs: 1, maxDelayMs: 50 },
  compaction: { maxContextEstTokens: 200000, workingWindowEstTokens: 8000 },
  probe: {
    model: { apiBaseUrl: 'mock', apiKey: 'k', model: 'mock-probe', apiFormat: 'openai-chat' },
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
      parts: [
        { kind: 'toolCall', callId: 'call1', name: 'send_message', args: JSON.stringify({ text: 'hi alice' }) },
        { kind: 'toolCall', callId: 'call2', name: 'bash', args: JSON.stringify({ command: 'date', timeout_seconds: 5 }) },
      ],
      reasoning: undefined,
    },
    {
      kind: 'toolResult',
      callId: 'call1',
      payload: JSON.stringify({ ok: true, message_id: '2' }),
      requiresFollowUp: false,
    },
    {
      kind: 'toolResult',
      callId: 'call2',
      payload: JSON.stringify({ exit_code: 0, output: 'Mon Jan  1 00:00:02 UTC 2025\n' }),
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
            args: JSON.stringify({
              should_act: true,
              reason: 'Alice asked the bot directly. Plausible: (a) react 👀 to acknowledge, (b) reply with a brief comment, (c) search for current info first.',
            }),
          }],
          reasoning: undefined,
        }];
        return { entries: out, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      }
      // primary: returns a send_message tool call so the runner accepts and
      // exits (send_message default await_response=false → no follow-up).
      const out: ConversationEntry[] = [{
        kind: 'message',
        role: 'assistant',
        parts: [{
          kind: 'toolCall',
          callId: 'primary1',
          name: 'send_message',
          args: JSON.stringify({ text: 'I am fine, thanks!' }),
        }],
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

    // Probe sees non-send-message tool calls as <tool-call> XML elements.
    expect(probeUserText).toContain('<tool-call name="bash"');
    expect(probeUserText).toContain('Mon Jan  1 00:00:02 UTC 2025');
    // send_message is NOT rendered as <tool-call> — it's already in the chat as <message>.
    expect(probeUserText).not.toContain('<tool-call name="send_message"');

    // Primary does NOT see the bot's outgoing message as user-side XML.
    // (`hi alice` is the bot's sent content — present in probe RC, absent in primary RC.)
    expect(primaryUserText).not.toContain('hi alice');
    expect(primaryUserText).toContain('hello bot');
    expect(primaryUserText).toContain('how are you?');
    // Primary doesn't see the rendered bash tool-call output either — that's a probe-only synthesis.
    // (Late-binding mentions the `<tool-call>` markup by name, so we assert on the unique result string.)
    expect(primaryUserText).not.toContain('Mon Jan  1 00:00:02 UTC 2025');

    // Primary DOES see the assistant's send_message tool call (real assistant entry).
    const primaryAssistantToolCalls = collectAssistantToolCallNames(primaryCall![1]);
    expect(primaryAssistantToolCalls).toContain('send_message');
    expect(primaryAssistantToolCalls).toContain('bash');

    // Primary's late-binding embeds the probe's reason as advisory.
    expect(primaryUserText).toContain('evaluator\'s notes');
    expect(primaryUserText).toContain('advisory only');
    expect(primaryUserText).toContain('Plausible: (a) react 👀');

    // Probe sees no real assistant tool calls in its context — all TRs are
    // stripped; the only tool-call signal is the <tool-call> XML in user text.
    const probeAssistantToolCalls = collectAssistantToolCallNames(probeCall![1]);
    expect(probeAssistantToolCalls).toEqual([]);

    driver.stop();
  });

  it('runs a forced send_message fallback when primary ends loop with end_turn but no send_message', async () => {
    mockCallLlm.mockReset();

    // Track which primary call this is — first call returns end_turn (no
    // send_message), fallback call must be invoked with forceToolChoice
    // pointing to send_message.
    let primaryCallCount = 0;
    let fallbackCall: typeof mockCallLlm.mock.calls[0] | undefined;

    mockCallLlm.mockImplementation(async (config, _entries) => {
      if (config.model === 'mock-probe') {
        return {
          entries: [{
            kind: 'message', role: 'assistant', reasoning: undefined,
            parts: [{
              kind: 'toolCall', callId: 'p1', name: 'decide',
              args: JSON.stringify({ should_act: true, reason: 'addressed' }),
            }],
          }],
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      // primary
      primaryCallCount++;
      if (primaryCallCount === 1) {
        // First primary call: end_turn alone (no send_message).
        return {
          entries: [{
            kind: 'message', role: 'assistant', reasoning: undefined,
            parts: [{ kind: 'toolCall', callId: 'pr1', name: 'end_turn', args: '{}' }],
          }],
          usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      // Second primary call (the fallback): send_message.
      fallbackCall = mockCallLlm.mock.calls[mockCallLlm.mock.calls.length - 1];
      return {
        entries: [{
          kind: 'message', role: 'assistant', reasoning: undefined,
          parts: [{
            kind: 'toolCall', callId: 'pr2', name: 'send_message',
            args: JSON.stringify({ text: 'forced fallback message' }),
          }],
        }],
        usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    });

    const persistedTRs: TurnResponseV2[] = [];
    const sendMessageCalls: { text: string }[] = [];

    const driver = createDriver(
      { chatIds: ['-100124'], resolveChatConfig: () => makeChatConfig() },
      {
        loadTurnResponses: async () => [...persistedTRs],
        persistTurnResponse: async (_, tr) => { persistedTRs.push(tr); },
        persistProbeResponse: async () => {},
        sendMessage: async (_chatId, text) => { sendMessageCalls.push({ text }); return { messageId: 999, date: 0 }; },
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

    driver.handleEvent('-100124', buildRC());

    // 1 probe + 1 primary (end_turn) + 1 fallback (send_message) = 3
    await vi.waitFor(() => expect(mockCallLlm).toHaveBeenCalledTimes(3), { timeout: 1000, interval: 10 });

    expect(primaryCallCount).toBe(2);
    expect(fallbackCall).toBeDefined();
    // Fallback call's config carries the specific tool_choice constraint.
    expect(fallbackCall![0]!.forceToolChoice).toEqual({ name: 'send_message' });
    // Actual TG send happened once (the fallback message).
    expect(sendMessageCalls).toEqual([{ text: 'forced fallback message' }]);

    driver.stop();
  });
});
