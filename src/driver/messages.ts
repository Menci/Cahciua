import type { Logger } from '@guiiai/logg';

import type { ThinkingConfig } from './types';
import type {
  MessagesAssistantContentBlock,
  MessagesMessage,
  MessagesResponse,
} from '../unified-api/anthropic-types';

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

const DEFAULT_MAX_TOKENS = 8192;
const THINKING_BUDGET_HIGH = 5000;
const THINKING_BUDGET_MAX = 10000;

const buildThinkingParam = (thinking?: ThinkingConfig): { type: 'enabled'; budget_tokens: number } | undefined => {
  if (!thinking || thinking.type === 'disabled') return undefined;
  return { type: 'enabled', budget_tokens: thinking.effort === 'max' ? THINKING_BUDGET_MAX : THINKING_BUDGET_HIGH };
};

// Anthropic prompt cache TTL. We pick 1h over 5min for both breakpoints:
// chat history is append-only and reused across many turns, so 1h's 2× write
// cost is amortized after ~7 reads, and a single 5min refresh (1.25 + 1.25 =
// 2.5×) already costs more than one 1h write that survives the gap.
const CACHE_1H = { type: 'ephemeral' as const, ttl: '1h' as const };

export interface AnthropicCacheTagged {
  system: { type: 'text'; text: string; cache_control: typeof CACHE_1H }[] | undefined;
  messages: MessagesMessage[];
}

// Tag a cache breakpoint on `system` (covers system + tools) and on the last
// block of the second-to-last message. The last message holds late-binding
// (primary turns) or the compaction instruction — content that mutates every
// turn — so we exclude it from the cache prefix.
//
// We shallow-clone only what we mutate so the caller's input stays untouched.
export const applyAnthropicCachePoints = (
  system: string | undefined,
  messages: MessagesMessage[],
): AnthropicCacheTagged => {
  const taggedSystem = system
    ? [{ type: 'text' as const, text: system, cache_control: CACHE_1H }]
    : undefined;

  if (messages.length < 2) return { system: taggedSystem, messages };

  const targetIdx = messages.length - 2;
  const target = messages[targetIdx]!;
  if (!Array.isArray(target.content) || target.content.length === 0)
    return { system: taggedSystem, messages };

  const newContent = [...target.content];
  const lastIdx = newContent.length - 1;
  newContent[lastIdx] = { ...newContent[lastIdx]!, cache_control: CACHE_1H };

  const newMessages = [...messages];
  newMessages[targetIdx] = { ...target, content: newContent } as MessagesMessage;
  return { system: taggedSystem, messages: newMessages };
};

export interface MessagesApiParams {
  baseURL: string;
  apiKey: string;
  model: string;
  system?: { type: 'text'; text: string; cache_control?: unknown }[];
  messages: MessagesMessage[];
  tools?: AnthropicTool[];
  maxTokens?: number;
  timeoutSec?: number;
  thinking?: ThinkingConfig;
  forceToolCall?: boolean;
  onRequestBody?: (body: unknown) => void;
  log: Logger;
  label: string;
}

export interface MessagesApiResult {
  content: MessagesAssistantContentBlock[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  stop_reason: MessagesResponse['stop_reason'];
}

export const messagesApi = async (params: MessagesApiParams): Promise<MessagesApiResult> => {
  const { log, label } = params;
  const abortController = new AbortController();
  const timeout = params.timeoutSec
    ? setTimeout(() => abortController.abort(new Error(`messages request timed out after ${params.timeoutSec}s`)), params.timeoutSec * 1000)
    : undefined;

  try {
    const thinkingParam = buildThinkingParam(params.thinking);
    const maxTokens = params.maxTokens
      ?? (thinkingParam ? thinkingParam.budget_tokens + 4096 : DEFAULT_MAX_TOKENS);

    const requestBody = {
      model: params.model,
      max_tokens: maxTokens,
      ...(params.system ? { system: params.system } : {}),
      messages: params.messages,
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
      ...(params.forceToolCall && params.tools && params.tools.length > 0 ? { tool_choice: { type: 'any' } } : {}),
      ...(thinkingParam ? { thinking: thinkingParam } : {}),
    };
    params.onRequestBody?.(requestBody);
    const body = JSON.stringify(requestBody);

    const url = `${params.baseURL.replace(/\/$/, '')}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': params.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
      signal: abortController.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Messages API ${res.status}: ${text}`);
    }

    const json = await res.json() as MessagesResponse;

    for (const block of json.content) {
      if (block.type === 'text')
        log.withFields({ label, text: block.text }).log('content');
      else if (block.type === 'thinking')
        log.withFields({ label, reasoning: block.thinking }).log('reasoning');
      else if (block.type === 'tool_use')
        log.withFields({ label, tool: block.name, args: block.input }).log('tool call');
    }

    if (json.usage.cache_creation_input_tokens || json.usage.cache_read_input_tokens) {
      log.withFields({
        label,
        cacheWrite: json.usage.cache_creation_input_tokens ?? 0,
        cacheRead: json.usage.cache_read_input_tokens ?? 0,
        input: json.usage.input_tokens,
      }).log('cache');
    }

    const cacheReadTokens = json.usage.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = json.usage.cache_creation_input_tokens ?? 0;

    return {
      content: json.content,
      usage: {
        // Anthropic's input_tokens is the uncached remainder. Add cache reads
        // and writes so inputTokens is the full billable input total —
        // matches OpenAI's prompt_tokens / Responses' input_tokens semantics.
        inputTokens: json.usage.input_tokens + cacheReadTokens + cacheWriteTokens,
        outputTokens: json.usage.output_tokens,
        cacheReadTokens,
        cacheWriteTokens,
      },
      stop_reason: json.stop_reason,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
