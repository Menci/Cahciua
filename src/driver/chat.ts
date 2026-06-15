import type { Logger } from '@guiiai/logg';

import type { ThinkingConfig } from './types';
import type { ChatCompletionsAssistantMessage } from '../unified-api/chat-types';

interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ChatCompletionsParams {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  system?: string;
  tools?: ToolSchema[];
  timeoutSec?: number;
  thinking?: ThinkingConfig;
  forceToolChoice?: 'any' | { name: string };
  onRequestBody?: (body: unknown) => void;
  log: Logger;
  label: string;
}

export interface ChatCompletionsResult {
  choices: Array<{ finish_reason: string; message: ChatCompletionsAssistantMessage }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

interface ChatCompletionsRawUsage {
  prompt_tokens: number;
  completion_tokens: number;
  // OpenAI: nested under prompt_tokens_details.cached_tokens.
  // DeepSeek (and a few clones): top-level prompt_cache_hit_tokens.
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
}

interface ChatCompletionsRawResult {
  choices: Array<{ finish_reason: string; message: ChatCompletionsAssistantMessage }>;
  usage: ChatCompletionsRawUsage;
}

export const chatCompletions = async (params: ChatCompletionsParams): Promise<ChatCompletionsResult> => {
  const { log, label } = params;
  const abortController = new AbortController();
  const timeout = params.timeoutSec
    ? setTimeout(() => abortController.abort(new Error(`chat request timed out after ${params.timeoutSec}s`)), params.timeoutSec * 1000)
    : undefined;

  try {
    const requestBody = {
      model: params.model,
      messages: [
        ...(params.system ? [{ role: 'system', content: params.system }] : []),
        ...params.messages,
      ],
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
      ...(params.forceToolChoice && params.tools && params.tools.length > 0
        ? { tool_choice: params.forceToolChoice === 'any'
          ? 'required'
          : { type: 'function' as const, function: { name: params.forceToolChoice.name } } }
        : {}),
      // Chat Completions takes the flat `reasoning_effort` field. type === 'disabled' or
      // no thinking config → omit the field entirely; standard OpenAI rejects 'none', and
      // unknown values like 'disabled' get silently ignored (still activating thinking),
      // so the safe off switch is to not send the field at all.
      ...(params.thinking && params.thinking.type !== 'disabled' && params.thinking.effort
        ? { reasoning_effort: params.thinking.effort }
        : {}),
    };
    params.onRequestBody?.(requestBody);
    const body = JSON.stringify(requestBody);

    const url = `${params.baseURL.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${params.apiKey}`,
      },
      body,
      signal: abortController.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Chat Completions API ${res.status}: ${text}`);
    }

    const json = await res.json() as ChatCompletionsRawResult;

    const choice = json.choices[0];
    if (choice) {
      if (choice.message.content)
        log.withFields({ label, text: choice.message.content }).log('content');
      const reasoning = choice.message.reasoning_text ?? choice.message.reasoning_content ?? choice.message.reasoning;
      if (reasoning)
        log.withFields({ label, reasoning }).log('reasoning');
      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          let args: unknown = tc.function.arguments;
          try { args = JSON.parse(tc.function.arguments); } catch { /* keep raw string */ }
          log.withFields({ label, tool: tc.function.name, args }).log('tool call');
        }
      }
    }

    // OpenAI's prompt_tokens already includes cache hits — cached_tokens is a
    // subset, not an additional bucket. OpenAI doesn't distinguish cache writes,
    // so cacheWriteTokens stays 0 on this path.
    const cacheReadTokens = json.usage.prompt_tokens_details?.cached_tokens
      ?? json.usage.prompt_cache_hit_tokens
      ?? 0;

    return {
      choices: json.choices,
      usage: {
        inputTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
      },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
