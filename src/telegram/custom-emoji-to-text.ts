import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';

import type { CustomEmojiInfo } from './bot';
import { renderCustomEmojiToTextSystemPrompt } from './custom-emoji-to-text-prompt';
import { deduplicateFrames, extractFrames } from './frame-extractor';
import type { ImageAltTextRecord } from './image-to-text';
import { callDescriptionLlm, createSemaphore } from './llm-description';
import type { Attachment } from './message';
import { resolveStickerSetMetadata } from './pack-title';
import type { LlmEndpoint } from '../driver/types';

const EMOJI_MAX_EDGE = 512;

export interface CustomEmojiToTextResolver {
  resolve(emojiIds: Map<string, string>): Promise<void>;
  getError(customEmojiId: string): string | undefined;
}

const emojiCacheKey = (customEmojiId: string): string => `emoji:${customEmojiId}`;

const prepareStaticImageUrl = async (buffer: Buffer): Promise<string> => {
  const resized = await sharp(buffer)
    .resize(EMOJI_MAX_EDGE, EMOJI_MAX_EDGE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  return `data:image/png;base64,${resized.toString('base64')}`;
};

const prepareFrameImageUrl = async (buffer: Buffer): Promise<string> => {
  const flattened = await sharp(buffer)
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  return `data:image/png;base64,${flattened.toString('base64')}`;
};

export const createCustomEmojiToTextResolver = (params: {
  enabled: boolean;
  model?: LlmEndpoint;
  maxConcurrency: number;
  maxFrames?: number;
  logger: Logger;
  lookupByHash: (hash: string) => ImageAltTextRecord | null;
  persist: (record: ImageAltTextRecord) => void;
  getCustomEmojiInfo: (customEmojiIds: string[]) => Promise<CustomEmojiInfo[]>;
  resolvePackTitle: (setName: string) => Promise<string>;
}): CustomEmojiToTextResolver => {
  const log = params.logger.withContext('telegram:custom-emoji-to-text');
  const semaphore = createSemaphore(params.maxConcurrency);
  const inflightByKey = new Map<string, Promise<void>>();
  const errors = new Map<string, string>();

  const resolveOne = (
    customEmojiId: string,
    fallbackEmoji: string,
    info: CustomEmojiInfo,
  ): Promise<void> => {
    const cacheKey = emojiCacheKey(customEmojiId);

    const existing = inflightByKey.get(cacheKey);
    if (existing) return existing;

    const task = (async () => {
      const cached = params.lookupByHash(cacheKey);
      if (cached) return;

      await semaphore.acquire();
      try {
        const recheck = params.lookupByHash(cacheKey);
        if (recheck) return;

        const model = params.model;
        if (!model) throw new Error('customEmojiToText.model is required when customEmojiToText.enabled=true');

        const buffer = await info.download();
        let isAnimated = info.isAnimated || info.isVideo;

        const packMetadata = await resolveStickerSetMetadata({ stickerSetId: info.setName }, params.resolvePackTitle);
        const packTitle = packMetadata.stickerSetName;

        let images: Array<{ url: string }>;
        let frameCount: number | undefined;
        let timestamps: string | undefined;

        if (isAnimated) {
          const syntheticAtt: Attachment = {
            type: 'sticker',
            isAnimatedSticker: info.isAnimated,
            isVideoSticker: info.isVideo,
          };
          const extractionResult = await extractFrames(buffer, syntheticAtt, params.maxFrames);
          const uniqueFrames = deduplicateFrames(extractionResult.frames);
          if (uniqueFrames.length === 1) isAnimated = false;
          images = await Promise.all(uniqueFrames.map(async buf => ({ url: await prepareFrameImageUrl(buf) })));
          frameCount = uniqueFrames.length;
          timestamps = extractionResult.frameTimestamps
            ? extractionResult.frameTimestamps.map(t => `${t.toFixed(1)}s`).join(', ')
            : undefined;
        } else {
          const url = await prepareStaticImageUrl(buffer);
          images = [{ url }];
        }

        const system = await renderCustomEmojiToTextSystemPrompt({
          fallbackEmoji,
          stickerSetName: packTitle,
          isAnimated,
          frameCount,
          frameTimestamps: timestamps,
        });

        const result = await callDescriptionLlm({
          model,
          system,
          userText: 'Describe this custom emoji.',
          images,
          log,
          label: 'custom-emoji-to-text',
        });
        const altText = result.text.trim();
        if (!altText) throw new Error('Custom-emoji-to-text model returned empty alt text');

        params.persist({
          imageHash: cacheKey,
          altText,
          altTextTokens: result.outputTokens,
          ...packTitle && { stickerSetName: packTitle },
        });
      } finally {
        semaphore.release();
      }
    })();

    inflightByKey.set(cacheKey, task);
    void task.finally(() => inflightByKey.delete(cacheKey)).catch(() => {});
    return task;
  };

  return {
    async resolve(emojiIds) {
      if (!params.enabled || emojiIds.size === 0) return;

      const uncached = new Map<string, string>();
      for (const [id, fallback] of emojiIds) {
        if (!params.lookupByHash(emojiCacheKey(id)))
          uncached.set(id, fallback);
      }
      if (uncached.size === 0) return;

      const ids = [...uncached.keys()];
      log.withFields({ count: ids.length }).log('Resolving custom emoji stickers');

      let infos: CustomEmojiInfo[];
      try {
        infos = await params.getCustomEmojiInfo(ids);
      } catch (err) {
        log.withError(err).warn('Failed to getCustomEmojiInfo');
        return;
      }

      const infoMap = new Map<string, CustomEmojiInfo>();
      for (const info of infos) infoMap.set(info.customEmojiId, info);

      const tasks: Promise<void>[] = [];
      for (const [id, fallback] of uncached) {
        const info = infoMap.get(id);
        if (!info) {
          log.withFields({ customEmojiId: id }).warn('Sticker not found for custom emoji');
          errors.set(id, 'sticker not found');
          continue;
        }
        tasks.push(
          resolveOne(id, fallback, info).catch(err => {
            log.withError(err).withFields({ customEmojiId: id }).warn('Failed to resolve custom emoji');
            errors.set(id, err instanceof Error ? err.message : String(err));
          }),
        );
      }

      await Promise.all(tasks);
    },

    getError(customEmojiId) {
      return errors.get(customEmojiId);
    },
  };
};

export { emojiCacheKey };
