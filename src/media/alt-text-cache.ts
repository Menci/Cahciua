import { createHash } from 'node:crypto';

import { visitCustomEmoji } from '../adaptation/content';
import type { PipelineEvent } from '../projection';
import type { ImageAltTextRecord } from './image-to-text';

export const hashBuffer = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');
export const computeThumbnailHash = (thumbnailWebp: string): string => hashBuffer(Buffer.from(thumbnailWebp, 'base64'));
export const emojiCacheKey = (customEmojiId: string): string => `emoji:${customEmojiId}`;

// Cache-only hydration is reusable without constructing resolvers or transports.
export const createCachedAltTextHydrator = (deps: {
  lookup: (hash: string) => ImageAltTextRecord | null;
  enabled: (kind: 'image' | 'animation' | 'emoji', chatId: string) => boolean;
}) => (event: PipelineEvent): void => {
  if (event.type !== 'message' && event.type !== 'edit') return;
  for (const attachment of event.attachments) {
    if (attachment.altText) continue;
    if (attachment.thumbnailWebp && deps.enabled('image', event.chatId)) {
      const cached = deps.lookup(computeThumbnailHash(attachment.thumbnailWebp));
      if (cached) {
        attachment.altText = cached.altText;
        continue;
      }
    }
    if (attachment.animationHash && deps.enabled('animation', event.chatId)) {
      const cached = deps.lookup(attachment.animationHash);
      if (cached) {
        attachment.altText = cached.altText;
        if (cached.stickerSetName) attachment.stickerSetName = cached.stickerSetName;
      }
    }
  }
  if (!deps.enabled('emoji', event.chatId)) return;
  visitCustomEmoji(event.content, node => {
    if (node.altText) return;
    const cached = deps.lookup(emojiCacheKey(node.customEmojiId));
    if (cached) {
      node.altText = cached.altText;
      if (cached.stickerSetName) node.stickerSetName = cached.stickerSetName;
    }
  });
};
