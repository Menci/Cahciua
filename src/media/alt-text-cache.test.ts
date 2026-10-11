import { describe, expect, it, vi } from 'vitest';

import { computeThumbnailHash, createCachedAltTextHydrator } from './alt-text-cache';
import type { ImageAltTextRecord } from './image-to-text';
import type { CanonicalMessageEvent } from '../adaptation/types';

const event = (): CanonicalMessageEvent => ({
  type: 'message', chatId: 'chat', messageId: '1', receivedAtMs: 1, timestampSec: 1, utcOffsetMin: 0,
  content: [{ type: 'bold', children: [{ type: 'custom_emoji', customEmojiId: '42', children: [{ type: 'text', text: 'emoji' }] }] }],
  attachments: [
    { type: 'animation', thumbnailWebp: 'aGVsbG8=', animationHash: 'animation' },
    { type: 'sticker', animationHash: 'animation' },
    { type: 'photo', thumbnailWebp: 'aGVsbG8=', altText: 'existing' },
  ],
});
const cache = new Map<string, ImageAltTextRecord>([
  [computeThumbnailHash('aGVsbG8='), { imageHash: 'photo', altText: 'photo description', altTextTokens: 1 }],
  ['animation', { imageHash: 'animation', altText: 'animation description', altTextTokens: 1, stickerSetName: 'pack' }],
  ['emoji:42', { imageHash: 'emoji:42', altText: 'emoji description', altTextTokens: 1, stickerSetName: 'emoji pack' }],
]);

describe('cache-only media hydration', () => {
  it('preserves thumbnail-first precedence, existing text, animation pack and recursive emoji behavior', () => {
    const input = event();
    const lookup = vi.fn((key: string) => cache.get(key) ?? null);
    createCachedAltTextHydrator({ lookup, enabled: () => true })(input);
    expect(input.attachments.map(a => a.altText)).toEqual(['photo description', 'animation description', 'existing']);
    expect(input.attachments[1]!.stickerSetName).toBe('pack');
    expect(input.content).toMatchObject([{ children: [{ altText: 'emoji description', stickerSetName: 'emoji pack' }] }]);
    expect(lookup.mock.calls.map(([key]) => key)).toEqual([computeThumbnailHash('aGVsbG8='), 'animation', 'emoji:42']);
  });

  it('honors per-chat feature selection and does no work for runtime/delete input', () => {
    const input = event();
    const lookup = vi.fn((key: string) => cache.get(key) ?? null);
    const hydrate = createCachedAltTextHydrator({ lookup, enabled: (kind, chatId) => kind === 'animation' && chatId === 'chat' });
    hydrate(input);
    expect(input.attachments[0]!.altText).toBe('animation description');
    expect(input.content).not.toMatchObject([{ children: [{ altText: 'emoji description' }] }]);
    hydrate({ ...input, type: 'delete', messageIds: ['1'] });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
