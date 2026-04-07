import type { Logger } from '@guiiai/logg';

import { renderAnimationToTextSystemPrompt } from './animation-to-text-prompt';
import type { ImageAltTextRecord } from './image-to-text';
import { callDescriptionLlm, createSemaphore } from './llm-description';
import type { LlmEndpoint } from '../driver/types';

export interface AnimationToTextResolver {
  resolve(params: {
    cacheKey: string;
    frames: Buffer[];
    caption: string;
    isSticker: boolean;
    emoji?: string;
    duration?: number;
  }): Promise<ImageAltTextRecord>;
}

export const createAnimationToTextResolver = (params: {
  enabled: boolean;
  model?: LlmEndpoint;
  maxConcurrency?: number;
  logger: Logger;
  lookupByHash: (hash: string) => ImageAltTextRecord | null;
  persist: (record: ImageAltTextRecord) => void;
}): AnimationToTextResolver => {
  const log = params.logger.withContext('telegram:animation-to-text');
  const semaphore = createSemaphore(params.maxConcurrency ?? 3);
  const inflightByHash = new Map<string, Promise<ImageAltTextRecord>>();

  const resolveByHash = (
    cacheKey: string,
    frames: Buffer[],
    caption: string,
    isSticker: boolean,
    emoji?: string,
    duration?: number,
  ): Promise<ImageAltTextRecord> => {
    const existing = inflightByHash.get(cacheKey);
    if (existing) return existing;

    const task = (async (): Promise<ImageAltTextRecord> => {
      const cached = params.lookupByHash(cacheKey);
      if (cached) return cached;

      await semaphore.acquire();
      try {
        const recheck = params.lookupByHash(cacheKey);
        if (recheck) return recheck;

        const model = params.model;
        if (!model) throw new Error('animationToText.model is required when animationToText.enabled=true');

        const images = frames.map(buf => ({
          url: `data:image/png;base64,${buf.toString('base64')}`,
        }));
        const system = await renderAnimationToTextSystemPrompt({
          caption,
          isSticker,
          emoji,
          duration,
          frameCount: frames.length,
        });

        const result = await callDescriptionLlm({
          model,
          system,
          userText: 'Describe this animation.',
          images,
          log,
          label: 'animation-to-text',
        });
        const altText = result.text.trim();
        if (!altText) throw new Error('Animation-to-text model returned empty alt text');

        const record: ImageAltTextRecord = {
          imageHash: cacheKey,
          altText,
          altTextTokens: result.outputTokens,
        };
        params.persist(record);
        return record;
      } finally {
        semaphore.release();
      }
    })();

    inflightByHash.set(cacheKey, task);
    void task.finally(() => inflightByHash.delete(cacheKey));
    return task;
  };

  return {
    resolve({ cacheKey, frames, caption, isSticker, emoji, duration }) {
      return resolveByHash(cacheKey, frames, caption, isSticker, emoji, duration);
    },
  };
};
