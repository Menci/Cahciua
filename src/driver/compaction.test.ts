import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../llm/call', () => ({ callLlm: vi.fn() }));

import { runCompaction } from './compaction';
import { callLlm } from '../llm/call';

initLogger(LogLevel.Error, Format.Pretty);

describe('runCompaction', () => {
  it('accumulates usage from empty-summary retries', async () => {
    vi.mocked(callLlm)
      .mockResolvedValueOnce({
        entries: [],
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      })
      .mockResolvedValueOnce({
        entries: [{
          kind: 'message',
          role: 'assistant',
          parts: [{ kind: 'text', text: 'summary' }],
          reasoning: undefined,
        }],
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
      });

    const result = await runCompaction({
      apiBaseUrl: 'mock',
      apiKey: 'key',
      model: 'model',
      apiFormat: 'openai-chat',
      chatId: 'chat',
      rcWindow: [{ receivedAtMs: 1, content: [{ type: 'text', text: 'history' }] }],
      trsWindow: [],
      oldCursorMs: 0,
      newCursorMs: 1,
      log: useLogger('compaction-test'),
    });

    expect(result).toMatchObject({
      summary: 'summary',
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
    });
  });
});
