import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';

import { renderCustomEmojiToTextSystemPrompt } from './custom-emoji-to-text-prompt';
import { extractFrames } from './frame-extractor';
import type { ImageAltTextRecord } from './image-to-text';
import { callDescriptionLlm, createSemaphore } from './llm-description';
import type { Attachment } from './message';
import type { LlmEndpoint } from '../driver/types';

const EMOJI_MAX_EDGE = 512;

export interface CustomEmojiToTextResolver {
  /** Resolve descriptions for a batch of custom emoji IDs. */
  resolve(emojiIds: Map<string, string>): Promise<void>;
}

const emojiCacheKey = (customEmojiId: string): string => `emoji:${customEmojiId}`;

const prepareStaticImageUrl = async (buffer: Buffer): Promise<string> => {
  const resized = await sharp(buffer)
    .resize(EMOJI_MAX_EDGE, EMOJI_MAX_EDGE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  return `data:image/png;base64,${resized.toString('base64')}`;
};

export const createCustomEmojiToTextResolver = (params: {
  enabled: boolean;
  model?: LlmEndpoint;
  maxConcurrency?: number;
  maxFrames?: number;
  logger: Logger;
  lookupByHash: (hash: string) => ImageAltTextRecord | null;
  persist: (record: ImageAltTextRecord) => void;
  getCustomEmojiStickers: (customEmojiIds: string[]) => Promise<Array<{
    file_id: string;
    is_animated: boolean;
    is_video: boolean;
    custom_emoji_id?: string;
  }>>;
  downloadFile: (fileId: string) => Promise<Buffer>;
}): CustomEmojiToTextResolver => {
  const log = params.logger.withContext('telegram:custom-emoji-to-text');
  const semaphore = createSemaphore(params.maxConcurrency ?? 3);
  const inflightByKey = new Map<string, Promise<void>>();

  const resolveOne = (
    customEmojiId: string,
    fallbackEmoji: string,
    sticker: { file_id: string; is_animated: boolean; is_video: boolean },
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

        const buffer = await params.downloadFile(sticker.file_id);
        const isAnimated = sticker.is_animated || sticker.is_video;

        let images: Array<{ url: string }>;
        let frameCount: number | undefined;

        if (isAnimated) {
          const syntheticAtt: Attachment = {
            type: 'sticker',
            isAnimatedSticker: sticker.is_animated,
            isVideoSticker: sticker.is_video,
          };
          const { frames } = await extractFrames(buffer, syntheticAtt, params.maxFrames);
          images = frames.map(buf => ({ url: `data:image/png;base64,${buf.toString('base64')}` }));
          frameCount = frames.length;
        } else {
          const url = await prepareStaticImageUrl(buffer);
          images = [{ url }];
        }

        const system = await renderCustomEmojiToTextSystemPrompt({
          fallbackEmoji,
          isAnimated,
          frameCount,
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
        });
      } finally {
        semaphore.release();
      }
    })();

    inflightByKey.set(cacheKey, task);
    void task.finally(() => inflightByKey.delete(cacheKey));
    return task;
  };

  return {
    async resolve(emojiIds) {
      if (!params.enabled || emojiIds.size === 0) return;

      // Filter out already-cached IDs
      const uncached = new Map<string, string>();
      for (const [id, fallback] of emojiIds) {
        if (!params.lookupByHash(emojiCacheKey(id)))
          uncached.set(id, fallback);
      }
      if (uncached.size === 0) return;

      const ids = [...uncached.keys()];
      log.withFields({ count: ids.length }).log('Resolving custom emoji stickers');

      // Bot API: at most 200 per call
      let stickers: Array<{
        file_id: string;
        is_animated: boolean;
        is_video: boolean;
        custom_emoji_id?: string;
      }>;
      try {
        stickers = await params.getCustomEmojiStickers(ids);
      } catch (err) {
        log.withError(err).warn('Failed to getCustomEmojiStickers');
        return;
      }

      // Build map: customEmojiId → sticker metadata
      const stickerMap = new Map<string, typeof stickers[0]>();
      for (const s of stickers) {
        if (s.custom_emoji_id) stickerMap.set(s.custom_emoji_id, s);
      }

      const tasks: Promise<void>[] = [];
      for (const [id, fallback] of uncached) {
        const sticker = stickerMap.get(id);
        if (!sticker) {
          log.withFields({ customEmojiId: id }).warn('Sticker not found for custom emoji');
          continue;
        }
        tasks.push(
          resolveOne(id, fallback, sticker).catch(err => {
            log.withError(err).withFields({ customEmojiId: id }).warn('Failed to resolve custom emoji');
          }),
        );
      }

      await Promise.all(tasks);
    },
  };
};

export { emojiCacheKey };
