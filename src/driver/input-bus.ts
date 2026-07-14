import type { RenderedContext } from '../rendering/types';

export interface DriverInputTarget {
  handleEvent(chatId: string, context: RenderedContext): void;
  handleTyping(chatId: string): void;
}

export const createDriverInputBus = () => {
  let target: DriverInputTarget | undefined;
  let active = false;
  let closed = false;
  const pendingContexts = new Map<string, RenderedContext>();

  const requireTarget = (): DriverInputTarget => {
    if (!target) throw new Error('Driver input received before Driver activation');
    return target;
  };

  return {
    attach(next: DriverInputTarget): void {
      if (target || closed) throw new Error('Driver input bus cannot be attached');
      target = next;
    },
    activate(): void {
      const current = requireTarget();
      if (active) throw new Error('Driver input bus is already active');
      active = true;
      for (const [chatId, context] of pendingContexts)
        current.handleEvent(chatId, context);
      pendingContexts.clear();
    },
    deactivate(): void {
      active = false;
      closed = true;
      target = undefined;
      pendingContexts.clear();
    },
    handleEvent(chatId: string, context: RenderedContext): void {
      if (closed) return;
      const current = requireTarget();
      if (active) current.handleEvent(chatId, context);
      else pendingContexts.set(chatId, context);
    },
    handleTyping(chatId: string): void {
      if (closed) return;
      const current = requireTarget();
      if (active) current.handleTyping(chatId);
    },
  };
};

export type DriverInputBus = ReturnType<typeof createDriverInputBus>;
