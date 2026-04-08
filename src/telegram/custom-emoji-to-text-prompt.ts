import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdownString } from '@velin-dev/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const basePath = resolve(__dirname, '../../package.json');
const promptTemplate = readFileSync(resolve(__dirname, '../../prompts/custom-emoji-to-text-system.velin.md'), 'utf-8');

export const renderCustomEmojiToTextSystemPrompt = async (params: {
  fallbackEmoji: string;
  isAnimated: boolean;
  frameCount?: number;
}) => {
  const { rendered } = await renderMarkdownString(promptTemplate, {
    fallbackEmoji: params.fallbackEmoji,
    isAnimated: params.isAnimated,
    frameCount: params.frameCount,
  }, basePath);
  return rendered;
};
