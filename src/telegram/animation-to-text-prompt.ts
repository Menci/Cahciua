import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdownString } from '@velin-dev/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const basePath = resolve(__dirname, '../../package.json');
const animationPrompt = readFileSync(resolve(__dirname, '../../prompts/animation-to-text-system.velin.md'), 'utf-8');
const stickerPrompt = readFileSync(resolve(__dirname, '../../prompts/sticker-animation-to-text-system.velin.md'), 'utf-8');

export const renderAnimationToTextSystemPrompt = async (params: {
  caption: string;
  isSticker: boolean;
  isStatic?: boolean;
  emoji?: string;
  stickerSetName?: string;
  duration?: number;
  frameCount: number;
}) => {
  const template = params.isSticker ? stickerPrompt : animationPrompt;
  // Only pass props declared by each template to avoid Vue extraneous-props warnings
  const templateParams = params.isSticker
    ? { caption: params.caption, emoji: params.emoji, stickerSetName: params.stickerSetName, duration: params.duration, frameCount: params.frameCount, isStatic: params.isStatic }
    : { caption: params.caption, duration: params.duration, frameCount: params.frameCount };
  const { rendered } = await renderMarkdownString(template, templateParams, basePath);
  return rendered;
};
