import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdownString } from '@velin-dev/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(__dirname, '../../docs/system-prompt.velin.md'), 'utf-8');
const basePath = resolve(__dirname, '../../package.json');

export const renderSystemPrompt = async (params: {
  language?: string;
  currentChannel?: string;
  maxContextLoadTime?: number;
  timeNow: string;
  systemFiles?: { filename: string; content: string }[];
}) => {
  const { rendered } = await renderMarkdownString(template, params, basePath);
  return rendered;
};
