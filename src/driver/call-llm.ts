import { writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';

import { chatCompletions } from './chat';
import { DUMP_DIR } from './constants';
import { trimImages } from './context';
import { applyAnthropicCachePoints, messagesApi } from './messages';
import { responsesApi } from './responses';
import type { ProviderFormat, ThinkingConfig } from './types';
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
  thinking?: ThinkingConfig;
  forceToolCall?: boolean;
}

export interface ToolSchema {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface LlmCallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmCallResult {
  entries: ConversationEntry[];
  usage: LlmCallUsage;
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

    const response = await responsesApi({
      baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
      input, instructions: system, ...(wireTools ? { tools: wireTools } : {}),
      thinking: config.thinking, forceToolCall: config.forceToolCall,
      onRequestBody: body => dump(options?.dumpId, 'request', body),
      log: log!, label, timeoutSec: config.timeoutSec,
    });
    dump(options?.dumpId, 'response', response);

    const assistantItems = (response.output as unknown as ResponsesAssistantItem[]).filter(item =>
      item.type === 'message' || item.type === 'function_call' || item.type === 'reasoning');
    return {
      entries: fromResponsesOutput(assistantItems),
      usage: response.usage,
    };
  }

  if (apiFormat === 'anthropic-messages') {
    const { system: sysFromEntries, messages } = await toMessagesInput(prepared);
    const effectiveSystem = sysFromEntries ?? system;
    const wireTools = optionalTools(tools?.map(toAnthropicToolSchema));
    const tagged = applyAnthropicCachePoints(effectiveSystem, messages);

    const response = await messagesApi({
      baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
      system: tagged.system, messages: tagged.messages, ...(wireTools ? { tools: wireTools } : {}),
      thinking: config.thinking, forceToolCall: config.forceToolCall,
      onRequestBody: body => dump(options?.dumpId, 'request', body),
      log: log!, label, timeoutSec: config.timeoutSec,
    });
    dump(options?.dumpId, 'response', response);

    return {
      entries: fromMessagesOutput(response.content),
      usage: response.usage,
    };
  }

  // openai-chat (default)
  const chatMessages = await toChatCompletionsInput(prepared);
  const wireTools = optionalTools(tools?.map(toChatToolSchema));

  const response = await chatCompletions({
    baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
    messages: chatMessages, system, ...(wireTools ? { tools: wireTools } : {}),
    thinking: config.thinking, forceToolCall: config.forceToolCall,
    onRequestBody: body => dump(options?.dumpId, 'request', body),
    log: log!, label, timeoutSec: config.timeoutSec,
  });
  dump(options?.dumpId, 'response', response);

  const choice = response.choices[0];
  if (!choice) return { entries: [], usage: response.usage };

  return {
    entries: fromChatCompletionsOutput([choice.message as ChatCompletionsAssistantMessage]),
    usage: response.usage,
  };
};
