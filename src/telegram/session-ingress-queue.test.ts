import { describe, expect, it, vi } from 'vitest';

import { createSessionIngressQueue } from './session-ingress-queue';
import { setupLogger, useLogger } from '../config/logger';

setupLogger();

interface TestEvent {
  chatId: string;
  id: string;
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('createSessionIngressQueue', () => {
  it('starts later transforms early but commits in order', async () => {
    const first = deferred<TestEvent>();
    const started: string[] = [];
    const committed: string[] = [];

    const queue = createSessionIngressQueue<TestEvent>({
      logger: useLogger('test'),
      transformConcurrency: 2,
      transform: async event => {
        started.push(event.id);
        if (event.id === '1') return await first.promise;
        return event;
      },
      commit: event => {
        committed.push(event.id);
      },
    });

    queue.enqueue({ chatId: 'chat', id: '1' });
    queue.enqueue({ chatId: 'chat', id: '2' });

    await vi.waitFor(() => expect(started).toEqual(['1', '2']));
    expect(committed).toEqual([]);

    first.resolve({ chatId: 'chat', id: '1' });

    await vi.waitFor(() => expect(committed).toEqual(['1', '2']));
  });

  it('retries failed transforms without letting later events pass', async () => {
    vi.useFakeTimers();

    let attempts = 0;
    const committed: string[] = [];

    const queue = createSessionIngressQueue<TestEvent>({
      logger: useLogger('test'),
      transformConcurrency: 2,
      transform: async event => {
        if (event.id === '1' && attempts < 2) {
          attempts++;
          throw new Error('boom');
        }
        attempts++;
        return event;
      },
      commit: event => {
        committed.push(event.id);
      },
    });

    queue.enqueue({ chatId: 'chat', id: '1' });
    queue.enqueue({ chatId: 'chat', id: '2' });

    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();

    await vi.waitFor(() => expect(committed).toEqual(['1', '2']));
    expect(attempts).toBe(3);

    vi.useRealTimers();
  });

  it('retries failed commits without advancing the session cursor', async () => {
    vi.useFakeTimers();
    const committed: string[] = [];
    let attempts = 0;
    const queue = createSessionIngressQueue<TestEvent>({
      logger: useLogger('test'),
      transform: async event => event,
      commit: event => {
        attempts++;
        if (event.id === '1' && attempts === 1) throw new Error('commit failed');
        committed.push(event.id);
      },
    });

    queue.enqueue({ chatId: 'chat', id: '1' });
    queue.enqueue({ chatId: 'chat', id: '2' });
    await vi.runOnlyPendingTimersAsync();

    await vi.waitFor(() => expect(committed).toEqual(['1', '2']));
    expect(attempts).toBe(3);
    vi.useRealTimers();
  });
});
