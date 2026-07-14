import { createHash } from 'node:crypto';

import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';

import { renderImageToTextSystemPrompt } from './image-to-text-prompt';
import { callDescriptionLlm, createSemaphore } from './llm-description';
import type { CanonicalAttachment } from '../adaptation/types';
import type { LlmEndpoint } from '../llm/types';

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

export const computeThumbnailHash = (thumbnailWebp: string): string =>
  hashBuffer(Buffer.from(thumbnailWebp, 'base64'));

const prepareImageToTextBuffer = async (buffer: Buffer): Promise<Buffer> =>
  await sharp(buffer)
    .resize(IMAGE_TO_TEXT_MAX_EDGE, IMAGE_TO_TEXT_MAX_EDGE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();

export const createImageToTextResolver = (params: {
  model: LlmEndpoint;
  maxConcurrency: number;
  logger: Logger;
  lookupByHash: (imageHash: string) => ImageAltTextRecord | null;
  persist: (record: ImageAltTextRecord) => void;
}): ImageToTextResolver => {
  const log = params.logger.withContext('media:image-to-text');
  const semaphore = createSemaphore(params.maxConcurrency);
  const inflightByHash = new Map<string, Promise<ImageAltTextRecord>>();

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
        const recheck = params.lookupByHash(imageHash);
        if (recheck) return recheck;

        const imageBuffer = await prepareImageToTextBuffer(highResBuffer ?? thumbnailBuffer);
        const system = await renderImageToTextSystemPrompt({ caption });

        const result = await callDescriptionLlm({
          model: params.model,
          system,
          userText: 'Describe this image.',
          images: [imageBuffer],
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
    void task.then(
      () => inflightByHash.delete(imageHash),
      () => inflightByHash.delete(imageHash),
    );
    return task;
  };

  return {
    resolve(thumbnailBuffer, caption, highResBuffer) {
      return resolveByBuffer(thumbnailBuffer, caption, highResBuffer);
    },

    async hydrateCanonicalAttachments(attachments, caption) {
      await Promise.all(attachments.map(async att => {
        if (att.altText || !att.thumbnailWebp) return;
        const buffer = Buffer.from(att.thumbnailWebp, 'base64');
        const record = await resolveByBuffer(buffer, caption);
        att.altText = record.altText;
      }));
    },
  };
};
