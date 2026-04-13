import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdownString } from '@velin-dev/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const basePath = resolve(__dirname, '../../package.json');

const systemPromptTemplate = readFileSync(resolve(__dirname, '../../prompts/primary-system.velin.md'), 'utf-8');
const lateBindingTemplate = readFileSync(resolve(__dirname, '../../prompts/primary-late-binding.velin.md'), 'utf-8');
const compactionSystemTemplate = readFileSync(resolve(__dirname, '../../prompts/compaction-system.velin.md'), 'utf-8');
const compactionUserTemplate = readFileSync(resolve(__dirname, '../../prompts/compaction-late-binding.velin.md'), 'utf-8');

export const renderSystemPrompt = async (params: {
  language?: string;
  modelName: string;
  currentChannel?: string;
  maxContextLoadTime?: number;
  systemFiles?: { filename: string; content: string }[];
  hasBashTool?: boolean;
  hasWebSearchTool?: boolean;
  hasDownloadFileTool?: boolean;
  hasAttachmentSupport?: boolean;
  hasBackgroundTasks?: boolean;
}) => {
  const { rendered } = await renderMarkdownString(systemPromptTemplate, params, basePath);
  return rendered;
};

export const renderLateBindingPrompt = async (params: {
  timeNow: string;
  isProbeEnabled?: boolean;
  isProbing?: boolean;
  isMentioned?: boolean;
  isReplied?: boolean;
  activeBackgroundTasks?: { id: number; typeName: string; intention?: string; liveSummary: string; startedMs: number; timeoutMs: number }[];
}) => {
  const { rendered } = await renderMarkdownString(lateBindingTemplate, params, basePath);
  return rendered;
};

export const renderCompactionSystemPrompt = async () => {
  const { rendered } = await renderMarkdownString(compactionSystemTemplate, {}, basePath);
  return rendered;
};

export const renderCompactionUserInstruction = async () => {
  const { rendered } = await renderMarkdownString(compactionUserTemplate, {}, basePath);
  return rendered;
};
