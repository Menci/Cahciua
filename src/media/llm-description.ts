import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';

import { callLlm } from '../llm/call';
import type { LlmEndpoint } from '../llm/types';
import type { ConversationEntry, InputMessage, OutputMessage } from '../unified-api/types';

export const createSemaphore = (max: number) => {
  let current = 0;
  const queue: (() => void)[] = [];
  return {
    acquire: () => new Promise<void>(resolve => {
      if (current < max) {
        current++;
        resolve();
      } else {
        queue.push(resolve);
      }
    }),
    release: () => {
      current--;
      const next = queue.shift();
      if (next) {
        current++;
        next();
      }
    },
  };
};

const extractDescriptionText = (entries: ConversationEntry[]): string => {
  const text: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'message' || entry.role !== 'assistant') continue;
    for (const part of (entry as OutputMessage).parts) {
      if (part.kind === 'text') text.push(part.text);
      else if (part.kind === 'textGroup') text.push(...part.content.map(item => item.text));
    }
  }
  return text.join('').trim();
};

export const callDescriptionLlm = async (params: {
  model: LlmEndpoint;
  system: string;
  userText: string;
  images: Buffer[];
  log: Logger;
  label: string;
}): Promise<{ text: string; outputTokens: number }> => {
  const { model, system, userText, images, log, label } = params;
  log.withFields({
    systemLen: system.length,
    images: images.length,
    apiFormat: model.apiFormat,
  }).log(`${label} request`);

  const entries: ConversationEntry[] = [{
    kind: 'message',
    role: 'user',
    parts: [
      { kind: 'text', text: userText },
      ...images.map(image => ({
        kind: 'image' as const,
        image: sharp(image),
        detail: 'high' as const,
      })),
    ],
  } satisfies InputMessage];

  const result = await callLlm({
    apiBaseUrl: model.apiBaseUrl,
    apiKey: model.apiKey,
    model: model.model,
    apiFormat: model.apiFormat,
    timeoutSec: model.timeoutSec,
    extraBody: model.extraBody,
  }, entries, system, undefined, {
    log,
    label,
    maxImagesAllowed: model.maxImagesAllowed,
  });

  return {
    text: extractDescriptionText(result.entries),
    outputTokens: result.usage.outputTokens,
  };
};
