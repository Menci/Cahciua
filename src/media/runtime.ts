import type { Logger } from '@guiiai/logg';

import { createCachedAltTextHydrator } from './alt-text-cache';
import { createAnimationToTextResolver } from './animation-to-text';
import type { AnimationToTextResolver } from './animation-to-text';
import { createCustomEmojiToTextResolver } from './custom-emoji-to-text';
import type { CustomEmojiMedia, CustomEmojiToTextResolver } from './custom-emoji-to-text';
import { createImageToTextResolver } from './image-to-text';
import type { ImageAltTextRecord, ImageToTextResolver } from './image-to-text';
import { getChatIds, resolveChatConfig, resolveModel } from '../config/config';
import type { Config } from '../config/config';

export const createMediaRuntime = (deps: {
  config: Config;
  logger: Logger;
  lookupAltText: (hash: string) => ImageAltTextRecord | null;
  persistAltText: (record: ImageAltTextRecord) => void;
  getCustomEmojiInfo: (ids: string[]) => Promise<CustomEmojiMedia[]>;
}) => {
  let stopped = false;
  const lookupAltText = (hash: string) => stopped ? null : deps.lookupAltText(hash);
  const persistAltText = (record: ImageAltTextRecord) => { if (!stopped) deps.persistAltText(record); };
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
        lookupByHash: lookupAltText,
        persist: persistAltText,
      }));
    }
    if (config.animationToText.enabled) {
      if (!config.animationToText.model)
        throw new Error(`Chat ${chatId}: animationToText.model is required when enabled`);
      animationResolvers.set(chatId, createAnimationToTextResolver({
        model: resolveModel(deps.config, config.animationToText.model),
        maxConcurrency: config.animationToText.maxConcurrency,
        logger: deps.logger,
        lookupByHash: lookupAltText,
        persist: persistAltText,
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
        lookupByHash: lookupAltText,
        persist: persistAltText,
        getCustomEmojiInfo: deps.getCustomEmojiInfo,
      }));
    }
  }

  const hydrateAltText = createCachedAltTextHydrator({
    lookup: lookupAltText,
    enabled: (kind, chatId) => kind === 'image' ? imageResolvers.has(chatId)
      : kind === 'animation' ? animationResolvers.has(chatId) : customEmojiResolvers.has(chatId),
  });

  return {
    stop(): void { stopped = true; },
    imageResolvers,
    animationResolvers,
    customEmojiResolvers,
    animationMaxFrames,
    hydrateAltText,
  };
};

export type MediaRuntime = ReturnType<typeof createMediaRuntime>;
