import { computed, effect, signal } from 'alien-signals';

import { latestExternalEventMs, triggerSenderLatestMs } from './context';
import type { DebounceConfig } from './types';
import type { RenderedContext } from '../rendering/types';

type Signal<T> = {
  (): T;
  (value: T): void;
};

export const createReplyScheduler = (deps: {
  chatId: string;
  debounce: DebounceConfig;
  context: Signal<RenderedContext>;
  lastProcessedMs: Signal<number>;
  lastTurnInterrupted: Signal<boolean>;
  failedContext: Signal<RenderedContext | null>;
  execute: (contextAtStart: RenderedContext) => Promise<void>;
  onDebounceStateChange: (chatId: string, isDebouncing: boolean) => void;
}) => {
  const running = signal(false);
  const lastTypingMs = signal(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let windowStartMs: number | undefined;
  let debouncing = false;

  const setDebouncing = (value: boolean): void => {
    if (debouncing === value) return;
    debouncing = value;
    deps.onDebounceStateChange(deps.chatId, value);
  };

  const needsReply = computed(() => {
    const context = deps.context();
    if (context.length === 0 || context === deps.failedContext()) return false;
    if (deps.lastTurnInterrupted()) return true;
    return latestExternalEventMs(context, deps.lastProcessedMs()) != null;
  });

  const disposeEffect = effect(() => {
    const isRunning = running();
    const typingAt = lastTypingMs();
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (isRunning || !needsReply()) {
      windowStartMs = undefined;
      setDebouncing(false);
      return;
    }

    const currentTime = Date.now();
    windowStartMs ??= currentTime;
    setDebouncing(true);
    const latestTriggerMessageMs = triggerSenderLatestMs(
      deps.context(),
      deps.lastProcessedMs(),
    ) ?? currentTime;
    let fireAtMs = latestTriggerMessageMs + deps.debounce.initialDelayMs;
    if (typingAt > 0)
      fireAtMs = Math.max(fireAtMs, typingAt + deps.debounce.typingExtendMs);
    fireAtMs = Math.min(fireAtMs, windowStartMs + deps.debounce.maxDelayMs);

    timer = setTimeout(() => {
      timer = undefined;
      windowStartMs = undefined;
      setDebouncing(false);
      const contextAtStart = deps.context();
      running(true);
      void deps.execute(contextAtStart).finally(() => running(false));
    }, Math.max(0, fireAtMs - currentTime));
  });

  return {
    notifyTyping(): void {
      lastTypingMs(Date.now());
    },
    dispose(): void {
      if (timer) clearTimeout(timer);
      setDebouncing(false);
      disposeEffect();
    },
  };
};
