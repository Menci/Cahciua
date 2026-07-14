import { signal } from 'alien-signals';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReplyScheduler } from './scheduler';
import type { RenderedContext } from '../rendering/types';

const segment = (receivedAtMs: number, senderId: string): RenderedContext[number] => ({
  receivedAtMs,
  senderId,
  content: [{ type: 'text', text: senderId }],
});

describe('createReplyScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not extend the trigger sender deadline for another sender', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const context = signal<RenderedContext>([segment(1000, 'a')]);
    const execute = vi.fn(async () => {});
    const scheduler = createReplyScheduler({
      chatId: 'chat',
      debounce: { initialDelayMs: 100, typingExtendMs: 100, maxDelayMs: 500 },
      context,
      lastProcessedMs: signal(0),
      lastTurnInterrupted: signal(false),
      failedContext: signal<RenderedContext | null>(null),
      execute,
      onDebounceStateChange: () => {},
    });

    vi.setSystemTime(1050);
    context([segment(1000, 'a'), segment(1050, 'b')]);
    await vi.advanceTimersByTimeAsync(50);
    expect(execute).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('extends for typing but never past the hard cap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const execute = vi.fn(async () => {});
    const scheduler = createReplyScheduler({
      chatId: 'chat',
      debounce: { initialDelayMs: 100, typingExtendMs: 300, maxDelayMs: 250 },
      context: signal<RenderedContext>([segment(1000, 'a')]),
      lastProcessedMs: signal(0),
      lastTurnInterrupted: signal(false),
      failedContext: signal<RenderedContext | null>(null),
      execute,
      onDebounceStateChange: () => {},
    });

    vi.setSystemTime(1050);
    scheduler.notifyTyping();
    await vi.advanceTimersByTimeAsync(199);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });
});
