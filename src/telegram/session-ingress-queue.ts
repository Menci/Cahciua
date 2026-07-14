import type { Logger } from '@guiiai/logg';

const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30000;

const sleep = async (ms: number) => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

interface SessionEvent {
  chatId: string;
}

interface QueueEntry<T> {
  seq: number;
  event: T;
  status: 'queued' | 'transforming' | 'ready';
  result?: T;
  attempts: number;
  commitAttempts: number;
}

interface SessionState<T> {
  nextSeq: number;
  nextCommitSeq: number;
  activeTransforms: number;
  flushing: boolean;
  entries: Map<number, QueueEntry<T>>;
}

export interface SessionIngressQueue<T extends SessionEvent> {
  enqueue(event: T): void;
}

export const createSessionIngressQueue = <T extends SessionEvent>(params: {
  logger: Logger;
  transformConcurrency?: number;
  transform: (event: T) => Promise<T>;
  commit: (event: T) => void | Promise<void>;
}): SessionIngressQueue<T> => {
  const log = params.logger.withContext('telegram:ingress-queue');
  const transformConcurrency = params.transformConcurrency ?? 3;
  const sessions = new Map<string, SessionState<T>>();

  const getSession = (chatId: string): SessionState<T> => {
    const existing = sessions.get(chatId);
    if (existing) return existing;

    const state: SessionState<T> = {
      nextSeq: 0,
      nextCommitSeq: 0,
      activeTransforms: 0,
      flushing: false,
      entries: new Map(),
    };
    sessions.set(chatId, state);
    return state;
  };

  const cleanupSession = (chatId: string, state: SessionState<T>) => {
    if (state.entries.size === 0 && state.activeTransforms === 0)
      sessions.delete(chatId);
  };

  const flushReady = async (chatId: string, state: SessionState<T>): Promise<void> => {
    if (state.flushing) return;
    state.flushing = true;
    try {
      while (true) {
        const entry = state.entries.get(state.nextCommitSeq);
        if (entry?.status !== 'ready' || !entry.result) break;
        try {
          entry.commitAttempts++;
          await params.commit(entry.result);
          state.entries.delete(state.nextCommitSeq);
          state.nextCommitSeq++;
        } catch (error) {
          const delayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** (entry.commitAttempts - 1), RETRY_MAX_DELAY_MS);
          log.withError(error).withFields({
            chatId,
            seq: entry.seq,
            attempt: entry.commitAttempts,
            retryInMs: delayMs,
          }).error('Ingress commit failed; session remains blocked until success');
          await sleep(delayMs);
        }
      }
    } finally {
      state.flushing = false;
      cleanupSession(chatId, state);
    }
  };

  const pump = (chatId: string, state: SessionState<T>) => {
    while (state.activeTransforms < transformConcurrency) {
      const nextEntry = [...state.entries.values()]
        .filter(entry => entry.status === 'queued')
        .sort((a, b) => a.seq - b.seq)[0];
      if (!nextEntry) break;

      nextEntry.status = 'transforming';
      state.activeTransforms++;

      void (async () => {
        while (true) {
          nextEntry.attempts++;
          try {
            nextEntry.result = await params.transform(nextEntry.event);
            nextEntry.status = 'ready';
            break;
          } catch (err) {
            const delayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** (nextEntry.attempts - 1), RETRY_MAX_DELAY_MS);
            log.withError(err).withFields({
              chatId,
              seq: nextEntry.seq,
              attempt: nextEntry.attempts,
              retryInMs: delayMs,
            }).error('Ingress transform failed; session remains blocked until success');
            await sleep(delayMs);
          }
        }

        state.activeTransforms--;
        void flushReady(chatId, state);
        pump(chatId, state);
      })();
    }
  };

  return {
    enqueue(event) {
      const state = getSession(event.chatId);
      const seq = state.nextSeq++;
      state.entries.set(seq, {
        seq,
        event,
        status: 'queued',
        attempts: 0,
        commitAttempts: 0,
      });
      pump(event.chatId, state);
    },
  };
};
