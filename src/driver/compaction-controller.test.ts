import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { computed, effect, signal } from 'alien-signals';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./compaction', () => ({ runCompaction: vi.fn() }));

import { runCompaction } from './compaction';
import { createCompactionController } from './compaction-controller';
import { selectContextView } from './context-view';
import type { CompactionSessionMeta } from './types';
import { createPipeline } from '../pipeline';
import type { RenderedContext } from './context-types';

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

it('persists before advancing a pure view and never republishes rendering on metadata changes', async () => {
  vi.useFakeTimers();
  const pipeline = createPipeline({});
  const records = pipeline.pushEvent('chat', {
    type: 'message', chatId: 'chat', messageId: '1', receivedAtMs: 1000, timestampSec: 1, utcOffsetMin: 0,
    content: [{ type: 'text', text: 'long context' }], attachments: [],
  });
  const base = signal(records);
  const metadata = signal<CompactionSessionMeta | null>(null);
  const view = computed(() => selectContextView(base(), { cursorMs: metadata()?.newCursorMs }));
  const publication = vi.fn(() => base());
  const disposeObserver = effect(publication);
  const order: string[] = [];
  vi.mocked(runCompaction).mockReset().mockResolvedValue(meta(1001));
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
    context: view,
    compactionMeta: metadata,
    loadTurnResponses: async () => [],
    persistCompaction: () => {
      expect(metadata()).toBeNull();
      order.push('persist');
    },
    setCompactCursor: (id, cursor) => { order.push('cursor'); pipeline.setRenderWindow(id, { fromReceivedAtMs: cursor }); },
    log: useLogger('compaction-controller-test'),
  });
  try {
    await vi.runOnlyPendingTimersAsync();
    expect(runCompaction).toHaveBeenCalledOnce();
    expect(vi.mocked(runCompaction).mock.calls[0]![0]).toMatchObject({
      oldCursorMs: 0, newCursorMs: 1001, rcWindow: selectContextView(records, {}),
    });
    expect(order).toEqual(['persist', 'cursor']);
    expect(view()).toEqual([]);
    expect(base()).toBe(records);
    expect(publication).toHaveBeenCalledOnce();
    metadata({ ...meta(1001), summary: 'revised summary' });
    expect(publication).toHaveBeenCalledOnce();
    expect(pipeline.getRenderedChats()[0]![1]).toEqual([]);
  } finally {
    disposeObserver();
    controller.dispose();
    vi.useRealTimers();
  }
});
