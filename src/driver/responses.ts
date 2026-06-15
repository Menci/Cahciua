import type { Logger } from '@guiiai/logg';

import type {
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseTool,
  ResponsesResult,
} from './responses-types';
import type { ThinkingConfig } from './types';

export interface ResponsesApiParams {
  baseURL: string;
  apiKey: string;
  model: string;
  input: unknown[];
  instructions?: string;
  tools?: ResponseTool[];
  timeoutSec?: number;
  thinking?: ThinkingConfig;
  forceToolChoice?: 'any' | { name: string };
  onRequestBody?: (body: unknown) => void;
  log: Logger;
  label: string;
}

export interface ResponsesApiResult {
  output: ResponseOutputItem[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  status: string;
}

export const responsesApi = async (params: ResponsesApiParams): Promise<ResponsesApiResult> => {
  const { log, label } = params;
  const abortController = new AbortController();
  const timeout = params.timeoutSec
    ? setTimeout(() => abortController.abort(new Error(`responses request timed out after ${params.timeoutSec}s`)), params.timeoutSec * 1000)
    : undefined;

  try {
    const requestBody = {
      model: params.model,
      input: params.input,
      ...(params.instructions ? { instructions: params.instructions } : {}),
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
      ...(params.forceToolChoice && params.tools && params.tools.length > 0
        ? { tool_choice: params.forceToolChoice === 'any'
          ? 'required'
          : { type: 'function' as const, name: params.forceToolChoice.name } }
        : {}),
      ...(params.thinking?.effort ? { output_config: { effort: params.thinking.effort } } : {}),
    };
    params.onRequestBody?.(requestBody);
    const body = JSON.stringify(requestBody);

    const url = `${params.baseURL.replace(/\/$/, '')}/responses`;
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
      throw new Error(`Responses API ${res.status}: ${text}`);
    }

    const json = await res.json() as ResponsesResult;

    for (const item of json.output) {
      if (item.type === 'message') {
        const msg = item as ResponseOutputMessage;
        for (const block of msg.content) {
          if (block.type === 'output_text')
            log.withFields({ label, text: block.text }).log('content');
        }
      } else if (item.type === 'function_call') {
        let args: unknown = item.arguments;
        try { args = JSON.parse(item.arguments); } catch { /* keep raw string */ }
        log.withFields({ label, tool: item.name, args }).log('tool call');
      }
    }

    return {
      output: json.output,
      usage: {
        // Responses' input_tokens already includes cache hits; cached_tokens
        // is a breakdown, not an additional bucket. No separate write counter.
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        cacheReadTokens: json.usage?.input_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      },
      status: json.status,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
