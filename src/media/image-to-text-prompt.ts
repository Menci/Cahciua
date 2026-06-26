import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdownString } from '@velin-dev/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const basePath = resolve(__dirname, '../../package.json');
const systemPromptTemplate = readFileSync(resolve(__dirname, '../../prompts/image-to-text-system.velin.md'), 'utf-8');

export const renderImageToTextSystemPrompt = async (params: {
  caption: string;
  detail?: string;
}) => {
  const { rendered } = await renderMarkdownString(systemPromptTemplate, params, basePath);
  return rendered;
};
