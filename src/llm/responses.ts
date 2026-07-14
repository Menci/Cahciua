import type { Logger } from '@guiiai/logg';

import type { ResponsesAssistantItem } from '../unified-api/responses-types';

interface ResponseTool {
  type: 'function';
  name: string;
  parameters: Record<string, unknown>;
  strict: boolean;
  description?: string;
}

interface ResponsesResult {
  output: ResponsesAssistantItem[];
  status: 'completed' | 'failed' | 'incomplete' | 'in_progress';
  incomplete_details?: { reason: string };
  error?: { message: string };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: { cached_tokens: number };
  };
}

export interface ResponsesApiParams {
  baseURL: string;
  apiKey: string;
  model: string;
  input: unknown[];
  instructions?: string;
  tools?: ResponseTool[];
  timeoutSec?: number;
  extraBody?: Record<string, unknown>;
  forceToolChoice?: 'any' | { name: string };
  onRequestBody?: (body: unknown) => void;
  log: Logger;
  label: string;
}

export interface ResponsesApiResult {
  output: ResponsesAssistantItem[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
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
        ? {
            tool_choice: params.forceToolChoice === 'any'
              ? 'required'
              : { type: 'function' as const, name: params.forceToolChoice.name },
          }
        : {}),
      ...params.extraBody,
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
    if (json.status !== 'completed') {
      const reason = json.error?.message ?? json.incomplete_details?.reason ?? json.status;
      throw new Error(`Responses API returned ${json.status}: ${reason}`);
    }
    if (!json.usage) throw new Error('Completed Responses API result has no usage');

    for (const item of json.output) {
      if (item.type === 'message') {
        for (const block of item.content) {
          if (block.type === 'output_text')
            log.withFields({ label, text: block.text }).log('content');
        }
      } else if (item.type === 'function_call') {
        let args: unknown = item.arguments;
        try { args = JSON.parse(item.arguments); } catch { /* keep raw string */ }
        log.withFields({ label, tool: item.name, args }).log('tool call');
      } else if (item.type === 'reasoning') {
        const reasoning = item.summary.map(s => s.text).join('\n');
        if (reasoning) log.withFields({ label, reasoning }).log('reasoning');
      }
    }

    return {
      output: json.output,
      usage: {
        // Responses' input_tokens already includes cache hits; cached_tokens
        // is a breakdown, not an additional bucket. No separate write counter.
        inputTokens: json.usage.input_tokens,
        outputTokens: json.usage.output_tokens,
        cacheReadTokens: json.usage.input_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
