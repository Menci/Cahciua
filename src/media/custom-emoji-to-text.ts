import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';

import { renderCustomEmojiToTextSystemPrompt } from './custom-emoji-to-text-prompt';
import { deduplicateFrames, extractFrames } from './frame-extractor';
import type { ImageAltTextRecord } from './image-to-text';
import { callDescriptionLlm, createSemaphore } from './llm-description';
import type { LlmEndpoint } from '../llm/types';

const EMOJI_MAX_EDGE = 512;

export interface CustomEmojiResolveItem {
  customEmojiId: string;
  fallbackEmoji: string;
  /** Resolved at ingress; absent only for the unknown-pack case. */
  stickerSetName?: string;
}

export interface CustomEmojiMedia {
  customEmojiId: string;
  format: 'static' | 'animated' | 'video';
  download: () => Promise<Buffer>;
}

export interface CustomEmojiToTextResolver {
  resolve(items: CustomEmojiResolveItem[]): Promise<void>;
}

const emojiCacheKey = (customEmojiId: string): string => `emoji:${customEmojiId}`;

const prepareStaticImageBuffer = async (buffer: Buffer): Promise<Buffer> =>
  await sharp(buffer)
    .resize(EMOJI_MAX_EDGE, EMOJI_MAX_EDGE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();

const prepareFrameImageBuffer = async (buffer: Buffer): Promise<Buffer> =>
  await sharp(buffer)
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();

export const createCustomEmojiToTextResolver = (params: {
  model: LlmEndpoint;
  maxConcurrency: number;
  maxFrames?: number;
  logger: Logger;
  lookupByHash: (hash: string) => ImageAltTextRecord | null;
  persist: (record: ImageAltTextRecord) => void;
  getCustomEmojiInfo: (customEmojiIds: string[]) => Promise<CustomEmojiMedia[]>;
}): CustomEmojiToTextResolver => {
  const log = params.logger.withContext('media:custom-emoji-to-text');
  const semaphore = createSemaphore(params.maxConcurrency);
  const inflightByKey = new Map<string, Promise<void>>();

  const resolveOne = (
    item: CustomEmojiResolveItem,
    info: CustomEmojiMedia,
  ): Promise<void> => {
    const cacheKey = emojiCacheKey(item.customEmojiId);

    const existing = inflightByKey.get(cacheKey);
    if (existing) return existing;

    const task = (async () => {
      const cached = params.lookupByHash(cacheKey);
      if (cached) return;

      await semaphore.acquire();
      try {
        const recheck = params.lookupByHash(cacheKey);
        if (recheck) return;

        const buffer = await info.download();
        let isAnimated = info.format !== 'static';
        const packTitle = item.stickerSetName;

        let images: Buffer[];
        let frameCount: number | undefined;
        let timestamps: string | undefined;

        if (isAnimated) {
          const syntheticAtt = {
            type: 'sticker',
            isAnimatedSticker: info.format === 'animated',
            isVideoSticker: info.format === 'video',
          } as const;
          const extractionResult = await extractFrames(buffer, syntheticAtt, params.maxFrames);
          const uniqueFrames = deduplicateFrames(extractionResult.frames);
          if (uniqueFrames.length === 1) isAnimated = false;
          images = await Promise.all(uniqueFrames.map(prepareFrameImageBuffer));
          frameCount = uniqueFrames.length;
          timestamps = extractionResult.frameTimestamps
            ? extractionResult.frameTimestamps.map(t => `${t.toFixed(1)}s`).join(', ')
            : undefined;
        } else {
          images = [await prepareStaticImageBuffer(buffer)];
        }

        const system = await renderCustomEmojiToTextSystemPrompt({
          fallbackEmoji: item.fallbackEmoji,
          stickerSetName: packTitle,
          isAnimated,
          frameCount,
          frameTimestamps: timestamps,
        });

        const result = await callDescriptionLlm({
          model: params.model,
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
    void task.then(
      () => inflightByKey.delete(cacheKey),
      () => inflightByKey.delete(cacheKey),
    );
    return task;
  };

  return {
    async resolve(items) {
      if (items.length === 0) return;

      const uncached = items.filter(it => !params.lookupByHash(emojiCacheKey(it.customEmojiId)));
      if (uncached.length === 0) return;

      const ids = [...new Set(uncached.map(it => it.customEmojiId))];
      log.withFields({ count: ids.length }).log('Resolving custom emoji stickers');

      const infos = await params.getCustomEmojiInfo(ids);

      const infoMap = new Map<string, CustomEmojiMedia>();
      for (const info of infos) infoMap.set(info.customEmojiId, info);

      const tasks: Promise<void>[] = [];
      for (const item of uncached) {
        const info = infoMap.get(item.customEmojiId);
        if (!info) throw new Error(`Sticker not found for custom emoji ${item.customEmojiId}`);
        tasks.push(resolveOne(item, info));
      }

      await Promise.all(tasks);
    },
  };
};

export { emojiCacheKey };
