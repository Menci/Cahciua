import { visitCustomEmoji } from '../adaptation/content';
import { computeThumbnailHash, emojiCacheKey } from '../media/alt-text-cache';
import type { PipelineEvent } from '../projection';

export const eventCacheKeys = (event: PipelineEvent): readonly string[] => {
  const keys = new Set<string>();
  if (event.type !== 'message' && event.type !== 'edit') return [];
  for (const attachment of event.attachments) {
    if (attachment.thumbnailWebp) keys.add(computeThumbnailHash(attachment.thumbnailWebp));
    if (attachment.animationHash) keys.add(attachment.animationHash);
  }
  visitCustomEmoji(event.content, node => { keys.add(emojiCacheKey(node.customEmojiId)); });
  if (event.type === 'message' && event.replyQuoteContent) visitCustomEmoji(event.replyQuoteContent, node => { keys.add(emojiCacheKey(node.customEmojiId)); });
  return [...keys];
};

export const needsAnimationHash = (event: PipelineEvent): boolean => (event.type === 'message' || event.type === 'edit')
  && event.attachments.some(attachment => !attachment.animationHash && (attachment.type === 'animation'
    || (attachment.type === 'sticker' && (attachment.format === 'animated' || attachment.format === 'video'))));
