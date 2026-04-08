import { createHash } from 'node:crypto';

import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';

import { renderImageToTextSystemPrompt } from './image-to-text-prompt';
import { callDescriptionLlm, createSemaphore } from './llm-description';
import type { CanonicalAttachment } from '../adaptation/types';
import type { LlmEndpoint } from '../driver/types';

const IMAGE_TO_TEXT_MAX_EDGE = 512;

export interface ImageAltTextRecord {
  imageHash: string;
  altText: string;
  altTextTokens: number;
  stickerSetName?: string;
}

export interface ImageToTextResolver {
  /** Generate + persist alt text. thumbnailBuffer used as cache key; highResBuffer (if provided) used for LLM input. */
  resolve(thumbnailBuffer: Buffer, caption: string, highResBuffer?: Buffer): Promise<ImageAltTextRecord>;
  /** Hydrate altText on canonical attachments from cache/LLM (for cold-start replay). */
  hydrateCanonicalAttachments(attachments: CanonicalAttachment[], caption: string): Promise<void>;
}

const hashBuffer = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');

/** Compute cache key from a base64-encoded thumbnail. */
export const computeThumbnailHash = (thumbnailWebp: string): string =>
  hashBuffer(Buffer.from(thumbnailWebp, 'base64'));

const prepareImageToTextUrl = async (buffer: Buffer): Promise<string> => {
  const resized = await sharp(buffer)
    .resize(IMAGE_TO_TEXT_MAX_EDGE, IMAGE_TO_TEXT_MAX_EDGE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  return `data:image/png;base64,${resized.toString('base64')}`;
};

export const createImageToTextResolver = (params: {
  enabled: boolean;
  model?: LlmEndpoint;
  maxConcurrency?: number;
  logger: Logger;
  lookupByHash: (imageHash: string) => ImageAltTextRecord | null;
  persist: (record: ImageAltTextRecord) => void;
}): ImageToTextResolver => {
  const log = params.logger.withContext('telegram:image-to-text');
  const semaphore = createSemaphore(params.maxConcurrency ?? 3);
  const inflightByHash = new Map<string, Promise<ImageAltTextRecord>>();

  // Core: thumbnail hash → dedup → cache lookup → semaphore-gated LLM → persist
  const resolveByBuffer = (
    thumbnailBuffer: Buffer,
    caption: string,
    highResBuffer?: Buffer,
  ): Promise<ImageAltTextRecord> => {
    const imageHash = hashBuffer(thumbnailBuffer);

    const existing = inflightByHash.get(imageHash);
    if (existing) return existing;

    const task = (async (): Promise<ImageAltTextRecord> => {
      const cached = params.lookupByHash(imageHash);
      if (cached) return cached;

      await semaphore.acquire();
      try {
        // Re-check after acquiring semaphore
        const recheck = params.lookupByHash(imageHash);
        if (recheck) return recheck;

        const model = params.model;
        if (!model) throw new Error('imageToText.model is required when imageToText.enabled=true');

        const imageUrl = await prepareImageToTextUrl(highResBuffer ?? thumbnailBuffer);
        const system = await renderImageToTextSystemPrompt({ caption });

        const result = await callDescriptionLlm({
          model,
          system,
          userText: 'Describe this image.',
          images: [{ url: imageUrl }],
          log,
          label: 'image-to-text',
        });
        const altText = result.text.trim();
        if (!altText) throw new Error('Image-to-text model returned empty alt text');

        const record: ImageAltTextRecord = {
          imageHash,
          altText,
          altTextTokens: result.outputTokens,
        };
        params.persist(record);
        return record;
      } finally {
        semaphore.release();
      }
    })();

    inflightByHash.set(imageHash, task);
    void task.finally(() => inflightByHash.delete(imageHash));
    return task;
  };

  return {
    resolve(thumbnailBuffer, caption, highResBuffer) {
      return resolveByBuffer(thumbnailBuffer, caption, highResBuffer);
    },

    async hydrateCanonicalAttachments(attachments, caption) {
      if (!params.enabled) return;
      await Promise.all(attachments.map(async att => {
        if (att.altText || !att.thumbnailWebp) return;
        const buffer = Buffer.from(att.thumbnailWebp, 'base64');
        const record = await resolveByBuffer(buffer, caption);
        att.altText = record.altText;
      }));
    },
  };
};
