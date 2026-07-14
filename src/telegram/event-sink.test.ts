import { describe, expect, it, vi } from 'vitest';

import { createTelegramEventSink } from './event-sink';
import type { CanonicalMessageEvent } from '../adaptation/types';
import type { RenderedContext } from '../rendering/types';

const event = (chatId: string): CanonicalMessageEvent => ({
  type: 'message',
  chatId,
  messageId: '1',
  receivedAtMs: 1,
  timestampSec: 1,
  utcOffsetMin: 0,
  sender: { id: 'u', displayName: 'User', isBot: false },
  content: [{ type: 'text', text: 'hello' }],
  attachments: [],
});

describe('createTelegramEventSink', () => {
  it('persists unconfigured events without hydration or publication', () => {
    const persistEvent = vi.fn();
    const hydrateAltText = vi.fn();
    const pushPipelineEvent = vi.fn();
    const handleDriverEvent = vi.fn();
    const sink = createTelegramEventSink({
      configuredChatIds: new Set(['configured']),
      persistEvent,
      hydrateAltText,
      pushPipelineEvent,
      handleDriverEvent,
    });
    const archived = event('archived');

    expect(sink.accept(archived)).toBeUndefined();
    expect(persistEvent).toHaveBeenCalledWith(archived);
    expect(hydrateAltText).not.toHaveBeenCalled();
    expect(pushPipelineEvent).not.toHaveBeenCalled();
    expect(handleDriverEvent).not.toHaveBeenCalled();
  });

  it('publishes configured events in hydrate, pipeline, driver order', () => {
    const order: string[] = [];
    const rendered: RenderedContext = [{ receivedAtMs: 1, content: [{ type: 'text', text: 'x' }] }];
    const sink = createTelegramEventSink({
      configuredChatIds: new Set(['configured']),
      persistEvent: () => order.push('persist'),
      hydrateAltText: () => order.push('hydrate'),
      pushPipelineEvent: () => {
        order.push('pipeline');
        return rendered;
      },
      handleDriverEvent: () => order.push('driver'),
    });

    expect(sink.accept(event('configured'))).toBe(rendered);
    expect(order).toEqual(['persist', 'hydrate', 'pipeline', 'driver']);
  });

  it('can publish synthetic events without notifying Driver', () => {
    const handleDriverEvent = vi.fn();
    const sink = createTelegramEventSink({
      configuredChatIds: new Set(['configured']),
      persistEvent: vi.fn(),
      hydrateAltText: vi.fn(),
      pushPipelineEvent: () => [],
      handleDriverEvent,
    });

    sink.accept(event('configured'), { notifyDriver: false });
    expect(handleDriverEvent).not.toHaveBeenCalled();
  });

  it('retries Driver notification without repeating persistence or Pipeline publication', () => {
    const persistEvent = vi.fn();
    const hydrateAltText = vi.fn();
    const pushPipelineEvent = vi.fn(() => []);
    const handleDriverEvent = vi.fn()
      .mockImplementationOnce(() => { throw new Error('driver unavailable'); })
      .mockImplementationOnce(() => {});
    const sink = createTelegramEventSink({
      configuredChatIds: new Set(['configured']),
      persistEvent,
      hydrateAltText,
      pushPipelineEvent,
      handleDriverEvent,
    });
    const message = event('configured');

    expect(() => sink.accept(message)).toThrow('driver unavailable');
    expect(() => sink.accept(message)).not.toThrow();
    expect(persistEvent).toHaveBeenCalledOnce();
    expect(hydrateAltText).toHaveBeenCalledOnce();
    expect(pushPipelineEvent).toHaveBeenCalledOnce();
    expect(handleDriverEvent).toHaveBeenCalledTimes(2);
  });
});
