import type { Logger } from '@guiiai/logg';

import { parseSSEStream } from './sse';
import type { ChatCompletionsAssistantMessage } from '../unified-api/chat-types';

// Chat Completions SSE chunk shape (subset we consume)
interface ChatStreamChunk {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: Array<{
    finish_reason?: string;
    delta?: {
      content?: string;
      reasoning_text?: string;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_opaque?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

// Tool schema for API serialization — only the fields sent over the wire.
interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface StreamingChatParams {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  system?: string;
  tools?: ToolSchema[];
  timeoutSec?: number;
  log: Logger;
  label: string; // log prefix, e.g. "step" or "compact"
}

export interface StreamingChatResult {
  choices: Array<{ finish_reason: string; message: ChatCompletionsAssistantMessage }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

// Parse an OpenAI-compatible SSE stream into a single ChatCompletion-shaped result.
// Logs every content/reasoning/tool_call delta as it arrives.
export const streamingChat = async (params: StreamingChatParams): Promise<StreamingChatResult> => {
  const { log, label } = params;
  const abortController = new AbortController();
  const timeout = params.timeoutSec
    ? setTimeout(() => abortController.abort(new Error(`chat request timed out after ${params.timeoutSec}s`)), params.timeoutSec * 1000)
    : undefined;

  try {
    const body = JSON.stringify({
      model: params.model,
      messages: [
        ...(params.system ? [{ role: 'system', content: params.system }] : []),
        ...params.messages,
      ],
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
      stream: true,
      stream_options: { include_usage: true },
    });

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

    const stream = res.body;
    if (!stream) throw new Error('SSE response has no body');

    // Accumulated state for the single choice we care about
    let finishReason = '';
    const message: ChatCompletionsAssistantMessage = { role: 'assistant' };
    let usage = { prompt_tokens: 0, completion_tokens: 0 };

    // Accumulators for logging batched deltas
    let textBuf = '';
    let reasoningBuf = '';

    const flushTextBuf = () => {
      if (textBuf) {
        log.withFields({ label, text: textBuf }).log('content delta');
        textBuf = '';
      }
    };

    const flushReasoningBuf = () => {
      if (reasoningBuf) {
        log.withFields({ label, reasoning: reasoningBuf }).log('reasoning delta');
        reasoningBuf = '';
      }
    };

    const processChunk = (chunk: ChatStreamChunk) => {
      // Usage (comes in the final chunk when streamOptions.includeUsage is true)
      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens ?? 0,
          completion_tokens: chunk.usage.completion_tokens ?? 0,
        };
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (!delta) return;

      if (choice.finish_reason)
        finishReason = choice.finish_reason;

      // Content text
      if (delta.content) {
        textBuf += delta.content;
        message.content ??= '';
        message.content += delta.content;
      }

      // Reasoning — different providers use different delta field names:
      //   reasoning_text + reasoning_opaque: Anthropic compat (text + signature)
      //   reasoning_content: DeepSeek, xAI, Qwen
      //   reasoning: vLLM, Groq, OpenRouter
      // All are accumulated as-is into the message object and persisted raw.
      // sanitizeReasoningForTR strips them on compat mismatch via whitelist.
      if (delta.reasoning_text) {
        reasoningBuf += delta.reasoning_text;
        message.reasoning_text ??= '';
        message.reasoning_text += delta.reasoning_text;
      }
      if (delta.reasoning_content) {
        reasoningBuf += delta.reasoning_content;
        message.reasoning_content ??= '';
        message.reasoning_content += delta.reasoning_content;
      }
      if (delta.reasoning) {
        reasoningBuf += delta.reasoning;
        message.reasoning ??= '';
        message.reasoning += delta.reasoning;
      }

      // Reasoning opaque signature (comes as a single chunk)
      if (delta.reasoning_opaque) {
        message.reasoning_opaque = (message.reasoning_opaque ?? '') + delta.reasoning_opaque;
      }

      // Tool calls — accumulate incrementally
      if (delta.tool_calls) {
        message.tool_calls ??= [];
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          message.tool_calls[idx] ??= {
            id: tc.id ?? '',
            type: 'function',
            function: { name: '', arguments: '' },
          };
          const existing = message.tool_calls[idx];
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) {
            flushTextBuf();
            flushReasoningBuf();
            existing.function.name += tc.function.name;
            log.withFields({ label, tool: existing.function.name }).log('tool call start');
          }
          if (tc.function?.arguments) {
            existing.function.arguments += tc.function.arguments;
          }
        }
      }
    };

    await parseSSEStream(stream, processChunk);
    flushTextBuf();
    flushReasoningBuf();

    return {
      choices: [{ finish_reason: finishReason, message }],
      usage,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
