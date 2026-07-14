import type { Logger } from '@guiiai/logg';

import { visitCustomEmoji } from '../adaptation/content';
import type { Config } from '../config/config';
import { getChatIds, resolveChatConfig, resolveModel } from '../config/config';
import type { PipelineEvent } from '../pipeline';
import { createAnimationToTextResolver } from './animation-to-text';
import type { AnimationToTextResolver } from './animation-to-text';
import { createCustomEmojiToTextResolver, emojiCacheKey } from './custom-emoji-to-text';
import type { CustomEmojiMedia, CustomEmojiToTextResolver } from './custom-emoji-to-text';
import { computeThumbnailHash, createImageToTextResolver } from './image-to-text';
import type { ImageAltTextRecord, ImageToTextResolver } from './image-to-text';

export const createMediaRuntime = (deps: {
  config: Config;
  logger: Logger;
  lookupAltText: (hash: string) => ImageAltTextRecord | null;
  persistAltText: (record: ImageAltTextRecord) => void;
  getCustomEmojiInfo: (ids: string[]) => Promise<CustomEmojiMedia[]>;
}) => {
  const imageResolvers = new Map<string, ImageToTextResolver>();
  const animationResolvers = new Map<string, AnimationToTextResolver>();
  const customEmojiResolvers = new Map<string, CustomEmojiToTextResolver>();
  const animationMaxFrames = new Map<string, number>();

  for (const chatId of getChatIds(deps.config)) {
    const config = resolveChatConfig(deps.config, chatId);
    if (config.imageToText.enabled) {
      if (!config.imageToText.model)
        throw new Error(`Chat ${chatId}: imageToText.model is required when enabled`);
      imageResolvers.set(chatId, createImageToTextResolver({
        model: resolveModel(deps.config, config.imageToText.model),
        maxConcurrency: config.imageToText.maxConcurrency,
        logger: deps.logger,
        lookupByHash: deps.lookupAltText,
        persist: deps.persistAltText,
      }));
    }
    if (config.animationToText.enabled) {
      if (!config.animationToText.model)
        throw new Error(`Chat ${chatId}: animationToText.model is required when enabled`);
      animationResolvers.set(chatId, createAnimationToTextResolver({
        model: resolveModel(deps.config, config.animationToText.model),
        maxConcurrency: config.animationToText.maxConcurrency,
        logger: deps.logger,
        lookupByHash: deps.lookupAltText,
        persist: deps.persistAltText,
      }));
      animationMaxFrames.set(chatId, config.animationToText.maxFrames);
    }
    if (config.customEmojiToText.enabled) {
      if (!config.customEmojiToText.model)
        throw new Error(`Chat ${chatId}: customEmojiToText.model is required when enabled`);
      customEmojiResolvers.set(chatId, createCustomEmojiToTextResolver({
        model: resolveModel(deps.config, config.customEmojiToText.model),
        maxFrames: config.customEmojiToText.maxFrames,
        maxConcurrency: config.customEmojiToText.maxConcurrency,
        logger: deps.logger,
        lookupByHash: deps.lookupAltText,
        persist: deps.persistAltText,
        getCustomEmojiInfo: deps.getCustomEmojiInfo,
      }));
    }
  }

  const hydrateAltText = (event: PipelineEvent): void => {
    if (event.type !== 'message' && event.type !== 'edit') return;
    for (const attachment of event.attachments) {
      if (attachment.altText) continue;
      if (attachment.thumbnailWebp && imageResolvers.has(event.chatId)) {
        const cached = deps.lookupAltText(computeThumbnailHash(attachment.thumbnailWebp));
        if (cached) {
          attachment.altText = cached.altText;
          continue;
        }
      }
      if (attachment.animationHash && animationResolvers.has(event.chatId)) {
        const cached = deps.lookupAltText(attachment.animationHash);
        if (cached) {
          attachment.altText = cached.altText;
          if (cached.stickerSetName) attachment.stickerSetName = cached.stickerSetName;
        }
      }
    }

    if (!customEmojiResolvers.has(event.chatId)) return;
    visitCustomEmoji(event.content, node => {
      if (node.altText) return;
      const cached = deps.lookupAltText(emojiCacheKey(node.customEmojiId));
      if (cached) {
        node.altText = cached.altText;
        if (cached.stickerSetName) node.stickerSetName = cached.stickerSetName;
      }
    });
  };

  return {
    imageResolvers,
    animationResolvers,
    customEmojiResolvers,
    animationMaxFrames,
    hydrateAltText,
  };
};

export type MediaRuntime = ReturnType<typeof createMediaRuntime>;
