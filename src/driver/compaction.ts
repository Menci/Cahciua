import { writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';

import { composeContext } from './context';
import { renderCompactionSystemPrompt, renderCompactionUserInstruction } from './prompt';
import { streamingChat } from './streaming';
import type { CompactionSessionMeta, FeatureFlags, TurnResponse } from './types';
import type { RenderedContext } from '../rendering/types';

export interface CompactionParams {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  chatId: string;
  rcWindow: RenderedContext;
  trsWindow: TurnResponse[];
  existingSummary?: string;
  oldCursorMs: number;
  newCursorMs: number;
  reasoningSignatureCompat?: string;
  featureFlags?: FeatureFlags;
  log: Logger;
}

// Token budget for compaction context — generous since we're summarizing, not chatting.
const COMPACT_MAX_TOKENS = 200000;
const MAX_RETRIES = 3;

export const runCompaction = async (params: CompactionParams): Promise<CompactionSessionMeta> => {
  const compactSystemPrompt = await renderCompactionSystemPrompt();
  const compactUserInstruction = await renderCompactionUserInstruction();

  // Reuse composeContext for full sanitization (reasoning stripping, self-sent
  // filtering, tool result trimming) — same pipeline as normal LLM calls.
  const ctx = composeContext(
    params.rcWindow,
    params.trsWindow,
    COMPACT_MAX_TOKENS,
    params.reasoningSignatureCompat,
    params.featureFlags,
    params.existingSummary,
  );

  const messages = ctx?.messages ?? [];

  messages.push({
    role: 'user',
    content: compactUserInstruction,
  } as any);

  const DUMP_DIR = '/tmp/cahciua';

  writeFileSync(`${DUMP_DIR}/${params.chatId}.compact-request.json`, JSON.stringify({
    model: params.model,
    system: compactSystemPrompt,
    messages,
  }, null, 2));

  // Retry loop — extended thinking models may produce thinking-only responses
  // (content: null) when no tools are provided. Retry on empty content.
  let summary = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await streamingChat({
      baseURL: params.apiBaseUrl,
      apiKey: params.apiKey,
      model: params.model,
      messages,
      system: compactSystemPrompt,
      log: params.log,
      label: `compact:${params.chatId}`,
    });

    writeFileSync(`${DUMP_DIR}/${params.chatId}.compact-response.json`, JSON.stringify(result, null, 2));

    summary = result.choices[0]?.message?.content ?? '';
    inputTokens = result.usage.prompt_tokens;
    outputTokens = result.usage.completion_tokens;
    if (summary) break;

    params.log.withFields({ chatId: params.chatId, attempt, maxRetries: MAX_RETRIES })
      .warn('Compaction LLM returned empty content, retrying');
  }

  return {
    oldCursorMs: params.oldCursorMs,
    newCursorMs: params.newCursorMs,
    summary,
    inputTokens,
    outputTokens,
  };
};
