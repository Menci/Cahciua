import { writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';

import { composeContext } from './context';
import { messagesToResponsesInput } from './convert';
import { renderCompactionSystemPrompt, renderCompactionUserInstruction } from './prompt';
import type { ResponseOutputMessage } from './responses-types';
import { streamingChat } from './streaming';
import { streamingResponses } from './streaming-responses';
import type { CompactionSessionMeta, FeatureFlags, ProviderFormat, TurnResponse } from './types';
import type { RenderedContext } from '../rendering/types';

export interface CompactionParams {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ProviderFormat;
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

const COMPACT_MAX_TOKENS = 200000;
const MAX_RETRIES = 3;
const DUMP_DIR = '/tmp/cahciua';

// Call the LLM (either provider) and extract text content from the response.
const callForText = async (
  params: CompactionParams,
  messages: any[],
  system: string,
): Promise<{ summary: string; inputTokens: number; outputTokens: number }> => {
  if ((params.apiFormat ?? 'openai-chat') === 'responses') {
    const result = await streamingResponses({
      baseURL: params.apiBaseUrl, apiKey: params.apiKey, model: params.model,
      input: messagesToResponsesInput(messages), instructions: system,
      log: params.log, label: `compact:${params.chatId}`,
    });
    writeFileSync(`${DUMP_DIR}/${params.chatId}.compact-response.json`, JSON.stringify(result, null, 2));
    const text = result.output
      .find((item): item is ResponseOutputMessage => item.type === 'message')
      ?.content.find(b => b.type === 'output_text')?.text ?? '';
    return { summary: text, inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens };
  }

  const result = await streamingChat({
    baseURL: params.apiBaseUrl, apiKey: params.apiKey, model: params.model,
    messages, system, log: params.log, label: `compact:${params.chatId}`,
  });
  writeFileSync(`${DUMP_DIR}/${params.chatId}.compact-response.json`, JSON.stringify(result, null, 2));
  return {
    summary: result.choices[0]?.message?.content ?? '',
    inputTokens: result.usage.prompt_tokens,
    outputTokens: result.usage.completion_tokens,
  };
};

export const runCompaction = async (params: CompactionParams): Promise<CompactionSessionMeta> => {
  const [compactSystemPrompt, compactUserInstruction] = await Promise.all([
    renderCompactionSystemPrompt(),
    renderCompactionUserInstruction(),
  ]);

  const ctx = composeContext(
    params.rcWindow, params.trsWindow, COMPACT_MAX_TOKENS,
    params.reasoningSignatureCompat, params.featureFlags, params.existingSummary,
  );

  const messages = [...(ctx?.messages ?? []), { role: 'user', content: compactUserInstruction } as any];

  writeFileSync(`${DUMP_DIR}/${params.chatId}.compact-request.json`, JSON.stringify({
    model: params.model, system: compactSystemPrompt, messages, apiFormat: params.apiFormat ?? 'openai-chat',
  }, null, 2));

  let summary = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    ({ summary, inputTokens, outputTokens } = await callForText(params, messages, compactSystemPrompt));
    if (summary) break;
    params.log.withFields({ chatId: params.chatId, attempt, maxRetries: MAX_RETRIES })
      .warn('Compaction LLM returned empty content, retrying');
  }

  return { oldCursorMs: params.oldCursorMs, newCursorMs: params.newCursorMs, summary, inputTokens, outputTokens };
};
