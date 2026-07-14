import type { CanonicalIMEvent } from '../adaptation/types';
import type { RenderedContext } from '../rendering/types';

export interface TelegramEventSink {
  persist(event: CanonicalIMEvent): void;
  publish(event: CanonicalIMEvent, options?: {
    hydrateAltText?: boolean;
    notifyDriver?: boolean;
  }): RenderedContext | undefined;
  accept(event: CanonicalIMEvent, options?: {
    hydrateAltText?: boolean;
    notifyDriver?: boolean;
  }): RenderedContext | undefined;
}

export const createTelegramEventSink = (deps: {
  configuredChatIds: ReadonlySet<string>;
  persistEvent: (event: CanonicalIMEvent) => void;
  hydrateAltText: (event: CanonicalIMEvent) => void;
  pushPipelineEvent: (chatId: string, event: CanonicalIMEvent) => RenderedContext;
  handleDriverEvent: (chatId: string, context: RenderedContext) => void;
}): TelegramEventSink => {
  const persisted = new WeakSet<CanonicalIMEvent>();
  const published = new WeakMap<CanonicalIMEvent, RenderedContext>();
  const notified = new WeakSet<CanonicalIMEvent>();

  const persist = (event: CanonicalIMEvent): void => {
    if (persisted.has(event)) return;
    deps.persistEvent(event);
    persisted.add(event);
  };

  const publish: TelegramEventSink['publish'] = (event, options = {}) => {
    if (!deps.configuredChatIds.has(event.chatId)) return undefined;
    let context = published.get(event);
    if (!context) {
      if (options.hydrateAltText !== false) deps.hydrateAltText(event);
      context = deps.pushPipelineEvent(event.chatId, event);
      published.set(event, context);
    }
    if (options.notifyDriver !== false && !notified.has(event)) {
      deps.handleDriverEvent(event.chatId, context);
      notified.add(event);
    }
    return context;
  };

  const accept: TelegramEventSink['accept'] = (event, options) => {
    persist(event);
    return publish(event, options);
  };

  return { persist, publish, accept };
};
