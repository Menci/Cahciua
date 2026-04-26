import type { Logger } from '@guiiai/logg';

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
  log: Logger;
  label: string;
}

export interface ChatCompletionsResult {
  choices: Array<{ finish_reason: string; message: ChatCompletionsAssistantMessage }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

export const chatCompletions = async (params: ChatCompletionsParams): Promise<ChatCompletionsResult> => {
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

    const json = await res.json() as ChatCompletionsResult;

    const choice = json.choices[0];
    if (choice) {
      if (choice.message.content)
        log.withFields({ label, text: choice.message.content }).log('content');
      const reasoning = choice.message.reasoning_text ?? choice.message.reasoning_content ?? choice.message.reasoning;
      if (reasoning)
        log.withFields({ label, reasoning }).log('reasoning');
      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls)
          log.withFields({ label, tool: tc.function.name }).log('tool call');
      }
    }

    return json;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
