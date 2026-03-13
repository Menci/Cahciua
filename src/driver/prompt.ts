import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderMarkdownString } from '@velin-dev/core';

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
