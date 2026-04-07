import type { Logger } from '@guiiai/logg';
import type { Message } from 'xsai';

import { streamingChat } from '../driver/streaming';
import { streamingResponses } from '../driver/streaming-responses';
import type { LlmEndpoint } from '../driver/types';

export const createSemaphore = (max: number) => {
  let current = 0;
  const queue: (() => void)[] = [];
  return {
    acquire: () => new Promise<void>(resolve => {
      if (current < max) { current++; resolve(); } else queue.push(resolve);
    }),
    release: () => {
      current--;
      const next = queue.shift();
      if (next) { current++; next(); }
    },
  };
};

const extractChatText = (message?: { content?: string | { text?: string }[] | null }): string => {
  if (!message?.content) return '';
  if (typeof message.content === 'string') return message.content.trim();
  return message.content
    .map(part => part.text ?? '')
    .join('')
    .trim();
};

const extractResponsesText = (output: Array<{ type: string; role?: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>): string =>
  output
    .filter(item => item.type === 'message' && item.role === 'assistant')
    .flatMap(item => item.content ?? [])
    .map(block => block.type === 'output_text' ? (block.text ?? '') : (block.refusal ?? ''))
    .join('')
    .trim();

export interface ImageContentPart {
  url: string;
  detail?: 'high' | 'low' | 'auto';
}

/** Shared LLM call for image/animation description workflows. */
export const callDescriptionLlm = async (params: {
  model: LlmEndpoint;
  system: string;
  userText: string;
  images: ImageContentPart[];
  log: Logger;
  label: string;
}): Promise<{ text: string; outputTokens: number }> => {
  const { model, system, userText, images, log, label } = params;

  log.withFields({ systemLen: system.length, images: images.length, apiFormat: model.apiFormat ?? 'openai-chat' }).log(`${label} request`);

  if ((model.apiFormat ?? 'openai-chat') === 'responses') {
    const input = [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: userText },
        ...images.map(img => ({ type: 'input_image', image_url: img.url, detail: img.detail ?? 'high' as const })),
      ],
    }];
    const response = await streamingResponses({
      baseURL: model.apiBaseUrl,
      apiKey: model.apiKey,
      model: model.model,
      instructions: system,
      input,
      log,
      label,
      timeoutSec: model.timeoutSec,
    });

    return {
      text: extractResponsesText(response.output as Array<{ type: string; role?: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>),
      outputTokens: response.usage.output_tokens,
    };
  }

  const chatMessages = [{
    role: 'user',
    content: [
      { type: 'text', text: userText },
      ...images.map(img => ({ type: 'image_url', image_url: { url: img.url, detail: img.detail ?? 'high' as const } })),
    ],
  } as Message];
  const response = await streamingChat({
    baseURL: model.apiBaseUrl,
    apiKey: model.apiKey,
    model: model.model,
    system,
    messages: chatMessages,
    log,
    label,
    timeoutSec: model.timeoutSec,
  });

  return {
    text: extractChatText(response.choices[0]?.message),
    outputTokens: response.usage.completion_tokens,
  };
};
