import type { Logger } from '@guiiai/logg';

import { chatCompletions } from './chat';
import { trimImages } from './images';
import { applyAnthropicCachePoints, messagesApi } from './messages';
import { dumpLlmPayload } from './request-dump';
import { responsesApi } from './responses';
import type { LlmEndpoint } from './types';
import {
  fromChatCompletionsOutput,
  fromMessagesOutput,
  fromResponsesOutput,
  toChatCompletionsInput,
  toMessagesInput,
  toResponsesInput,
} from '../unified-api';
import type { ChatCompletionsAssistantMessage } from '../unified-api/chat-types';
import type { ConversationEntry } from '../unified-api/types';

/** Force the model to call a tool. `'any'` requires at least one tool call but
 * leaves the choice to the model (and allows multiple parallel calls). `{name}`
 * forces exactly that tool — providers reject parallel calls in this mode. */
export type ForceToolChoice = 'any' | { name: string };

export interface LlmCallConfig extends Omit<LlmEndpoint, 'maxImagesAllowed'> {
  forceToolChoice?: ForceToolChoice;
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

export interface LlmCallOptions {
  log: Logger;
  label: string;
  dumpId?: string;
  maxImagesAllowed?: number;
}

const toResponsesToolSchema = (t: ToolSchema) => ({
  type: 'function' as const,
  name: t.name,
  parameters: t.parameters,
  strict: false,
  description: t.description,
});

const toAnthropicToolSchema = (t: ToolSchema) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters,
});

const toChatToolSchema = (t: ToolSchema) => ({
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
});

const optionalTools = <T>(mapped: T[] | undefined): T[] | undefined =>
  mapped === undefined || mapped.length === 0 ? undefined : mapped;

export const callLlm = async (
  config: LlmCallConfig,
  entries: ConversationEntry[],
  system: string,
  tools: ToolSchema[] | undefined,
  options: LlmCallOptions,
): Promise<LlmCallResult> => {
  const apiFormat = config.apiFormat ?? 'openai-chat';
  const { log, label } = options;

  let prepared = entries;
  if (options.maxImagesAllowed != null)
    prepared = trimImages(prepared, options.maxImagesAllowed);

  if (apiFormat === 'responses') {
    const input = await toResponsesInput(prepared);
    const wireTools = optionalTools(tools?.map(toResponsesToolSchema));

    const response = await responsesApi({
      baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
      input, instructions: system, ...(wireTools ? { tools: wireTools } : {}),
      extraBody: config.extraBody, forceToolChoice: config.forceToolChoice,
      onRequestBody: body => dumpLlmPayload(options.dumpId, 'request', body),
      log, label, timeoutSec: config.timeoutSec,
    });
    dumpLlmPayload(options.dumpId, 'response', response);

    const assistantItems = response.output.filter(item =>
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
      extraBody: config.extraBody, forceToolChoice: config.forceToolChoice,
      onRequestBody: body => dumpLlmPayload(options.dumpId, 'request', body),
      log, label, timeoutSec: config.timeoutSec,
    });
    dumpLlmPayload(options.dumpId, 'response', response);

    return {
      entries: fromMessagesOutput(response.content),
      usage: response.usage,
    };
  }

  const chatMessages = await toChatCompletionsInput(prepared);
  const wireTools = optionalTools(tools?.map(toChatToolSchema));

  const response = await chatCompletions({
    baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
    messages: chatMessages, system, ...(wireTools ? { tools: wireTools } : {}),
    extraBody: config.extraBody, forceToolChoice: config.forceToolChoice,
    onRequestBody: body => dumpLlmPayload(options.dumpId, 'request', body),
    log, label, timeoutSec: config.timeoutSec,
  });
  dumpLlmPayload(options.dumpId, 'response', response);

  const choice = response.choices[0];
  if (!choice) return { entries: [], usage: response.usage };

  return {
    entries: fromChatCompletionsOutput([choice.message as ChatCompletionsAssistantMessage]),
    usage: response.usage,
  };
};
