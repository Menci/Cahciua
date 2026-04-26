import type { Logger } from '@guiiai/logg';

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

export interface MessagesApiParams {
  baseURL: string;
  apiKey: string;
  model: string;
  system?: string;
  messages: MessagesMessage[];
  tools?: AnthropicTool[];
  maxTokens?: number;
  timeoutSec?: number;
  log: Logger;
  label: string;
}

export interface MessagesApiResult {
  content: MessagesAssistantContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: MessagesResponse['stop_reason'];
}

export const messagesApi = async (params: MessagesApiParams): Promise<MessagesApiResult> => {
  const { log, label } = params;
  const abortController = new AbortController();
  const timeout = params.timeoutSec
    ? setTimeout(() => abortController.abort(new Error(`messages request timed out after ${params.timeoutSec}s`)), params.timeoutSec * 1000)
    : undefined;

  try {
    const body = JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens ?? 8192,
      ...(params.system ? { system: params.system } : {}),
      messages: params.messages,
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    });

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
        log.withFields({ label, tool: block.name }).log('tool call');
    }

    return {
      content: json.content,
      usage: { input_tokens: json.usage.input_tokens, output_tokens: json.usage.output_tokens },
      stop_reason: json.stop_reason,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
