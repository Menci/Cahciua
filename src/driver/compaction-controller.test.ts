import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { signal } from 'alien-signals';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./compaction', () => ({ runCompaction: vi.fn() }));

import { runCompaction } from './compaction';
import { createCompactionController } from './compaction-controller';
import type { CompactionSessionMeta } from './types';
import type { RenderedContext } from '../rendering/types';

initLogger(LogLevel.Error, Format.Pretty);

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

const context = (receivedAtMs: number): RenderedContext => [{
  receivedAtMs,
  content: [{ type: 'text', text: 'long context' }],
}];

const meta = (cursor: number): CompactionSessionMeta => ({
  oldCursorMs: 0,
  newCursorMs: cursor,
  summary: `summary ${cursor}`,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

describe('createCompactionController', () => {
  afterEach(() => vi.useRealTimers());

  it('rechecks the latest context after a running compaction settles', async () => {
    vi.useFakeTimers();
    const first = deferred<CompactionSessionMeta>();
    vi.mocked(runCompaction)
      .mockImplementationOnce(async () => await first.promise)
      .mockResolvedValueOnce(meta(2));
    const rendered = signal(context(1));
    const controller = createCompactionController({
      chatId: 'chat',
      chatConfig: {
        primary: {
          model: { apiBaseUrl: 'mock', apiKey: 'key', model: 'model', apiFormat: 'openai-chat' },
        },
        systemFiles: [],
        sendTypingAction: false,
        blockedUserIds: [],
        debounce: { initialDelayMs: 1, typingExtendMs: 1, maxDelayMs: 1 },
        compaction: { maxContextEstTokens: 1, workingWindowEstTokens: 1 },
        probe: { model: { apiBaseUrl: 'mock', apiKey: 'key', model: 'probe', apiFormat: 'openai-chat' } },
        imageToText: { enabled: false, maxConcurrency: 1 },
        animationToText: { enabled: false, maxFrames: 1, maxConcurrency: 1 },
        customEmojiToText: { enabled: false, maxFrames: 1, maxConcurrency: 1 },
        tools: { banSpammer: false, bash: { backgroundThresholdSec: 10 } },
      },
      context: rendered,
      compactionMeta: signal<CompactionSessionMeta | null>(null),
      loadTurnResponses: async () => [],
      persistCompaction: vi.fn(),
      setCompactCursor: () => rendered(),
      log: useLogger('compaction-controller-test'),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(runCompaction).toHaveBeenCalledTimes(1);
    rendered(context(2));
    first.resolve(meta(1));
    await Promise.resolve();
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    expect(runCompaction).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});
