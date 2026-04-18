import { writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';

import { trimImages } from './context';
import { DUMP_DIR } from './constants';
import { streamingChat } from './streaming';
import { streamingMessages } from './streaming-messages';
import { streamingResponses } from './streaming-responses';
import type { ProviderFormat } from './types';
import {
  fromChatCompletionsOutput,
  fromMessagesOutput,
  fromResponsesOutput,
  toChatCompletionsInput,
  toMessagesInput,
  toResponsesInput,
} from '../unified-api';
import type { ChatCompletionsAssistantMessage } from '../unified-api/chat-types';
import type { ResponsesAssistantItem } from '../unified-api/responses-types';
import type { ConversationEntry } from '../unified-api/types';

export interface LlmCallConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ProviderFormat;
  timeoutSec?: number;
}

export interface ToolSchema {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface LlmCallResult {
  entries: ConversationEntry[];
  usage: { inputTokens: number; outputTokens: number };
}

const dump = (dumpId: string | undefined, suffix: string, body: unknown) => {
  if (dumpId) writeFileSync(`${DUMP_DIR}/${dumpId}.${suffix}.json`, JSON.stringify(body, null, 2));
};

const toResponsesToolSchema = (t: ToolSchema) => ({
  type: 'function' as const,
  name: t.name,
  parameters: t.parameters,
  strict: false,
  ...(t.description ? { description: t.description } : {}),
});

const toAnthropicToolSchema = (t: ToolSchema) => ({
  name: t.name,
  ...(t.description ? { description: t.description } : {}),
  input_schema: t.parameters,
});

const toChatToolSchema = (t: ToolSchema) => ({
  type: 'function' as const,
  function: {
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.parameters,
  },
});

const optionalTools = <T>(mapped: T[] | undefined): T[] | undefined =>
  mapped && mapped.length > 0 ? mapped : undefined;

export const callLlm = async (
  config: LlmCallConfig,
  entries: ConversationEntry[],
  system: string,
  tools?: ToolSchema[],
  options?: { log: Logger; label: string; dumpId?: string; maxImagesAllowed?: number },
): Promise<LlmCallResult> => {
  const apiFormat: ProviderFormat = config.apiFormat ?? 'openai-chat';
  const log = options?.log;
  const label = options?.label ?? '';

  let prepared = entries;
  if (options?.maxImagesAllowed != null)
    prepared = trimImages(prepared, options.maxImagesAllowed);

  if (apiFormat === 'responses') {
    const input = await toResponsesInput(prepared);
    const wireTools = optionalTools(tools?.map(toResponsesToolSchema));
    dump(options?.dumpId, 'request', { model: config.model, instructions: system, input, tools: wireTools });

    const response = await streamingResponses({
      baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
      input, instructions: system, ...(wireTools ? { tools: wireTools } : {}),
      log: log!, label, timeoutSec: config.timeoutSec,
    });
    dump(options?.dumpId, 'response', response);

    const assistantItems = (response.output as unknown as ResponsesAssistantItem[]).filter(item =>
      item.type === 'message' || item.type === 'function_call' || item.type === 'reasoning');
    return {
      entries: fromResponsesOutput(assistantItems),
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }

  if (apiFormat === 'anthropic-messages') {
    const { system: sysFromEntries, messages } = await toMessagesInput(prepared);
    const effectiveSystem = sysFromEntries ?? system;
    const wireTools = optionalTools(tools?.map(toAnthropicToolSchema));
    dump(options?.dumpId, 'request', { model: config.model, system: effectiveSystem, messages, tools: wireTools });

    const response = await streamingMessages({
      baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
      system: effectiveSystem, messages, ...(wireTools ? { tools: wireTools } : {}),
      log: log!, label, timeoutSec: config.timeoutSec,
    });
    dump(options?.dumpId, 'response', response);

    return {
      entries: fromMessagesOutput(response.content),
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }

  // openai-chat (default)
  const chatMessages = await toChatCompletionsInput(prepared);
  const wireTools = optionalTools(tools?.map(toChatToolSchema));
  dump(options?.dumpId, 'request', { model: config.model, system, messages: chatMessages, tools: wireTools });

  const response = await streamingChat({
    baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
    messages: chatMessages, system, ...(wireTools ? { tools: wireTools } : {}),
    log: log!, label, timeoutSec: config.timeoutSec,
  });
  dump(options?.dumpId, 'response', response);

  const choice = response.choices[0];
  if (!choice) return { entries: [], usage: { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens } };

  return {
    entries: fromChatCompletionsOutput([choice.message as ChatCompletionsAssistantMessage]),
    usage: { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens },
  };
};
