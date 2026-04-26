import type { Logger } from '@guiiai/logg';

import type {
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseTool,
  ResponsesResult,
} from './responses-types';

export interface ResponsesApiParams {
  baseURL: string;
  apiKey: string;
  model: string;
  input: unknown[];
  instructions?: string;
  tools?: ResponseTool[];
  timeoutSec?: number;
  log: Logger;
  label: string;
}

export interface ResponsesApiResult {
  output: ResponseOutputItem[];
  usage: { input_tokens: number; output_tokens: number };
  status: string;
}

export const responsesApi = async (params: ResponsesApiParams): Promise<ResponsesApiResult> => {
  const { log, label } = params;
  const abortController = new AbortController();
  const timeout = params.timeoutSec
    ? setTimeout(() => abortController.abort(new Error(`responses request timed out after ${params.timeoutSec}s`)), params.timeoutSec * 1000)
    : undefined;

  try {
    const body = JSON.stringify({
      model: params.model,
      input: params.input,
      ...(params.instructions ? { instructions: params.instructions } : {}),
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    });

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
        log.withFields({ label, tool: item.name }).log('tool call');
      }
    }

    return {
      output: json.output,
      usage: {
        input_tokens: json.usage?.input_tokens ?? 0,
        output_tokens: json.usage?.output_tokens ?? 0,
      },
      status: json.status,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
