import type { Logger } from '@guiiai/logg';

import { chatCompletions } from './chat';
import { trimImages } from './images';
import { applyAnthropicCachePoints, messagesApi } from './messages';
import { dumpLlmPayload } from './request-dump';
import { responsesApi } from './responses';
import type { ForceToolChoiceSupport, LlmEndpoint } from './types';
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
  /**
   * Set by the caller for the last-resort call that must yield a message. It is
   * the only call allowed to trade reasoning away for a forced choice on models
   * that cannot do both.
   */
  needsForcedOutput?: boolean;
}

/**
 * A forced call competes with reasoning: models advertised as
 * `reasoningDisabledOnly` accept a forced `tool_choice` only when thinking is
 * switched off. Ordinary turns keep their reasoning and simply go unforced;
 * only the last-resort call opts into disabling it, because ensuring the turn
 * produces a message matters more there than the model's deliberation.
 */
const resolveForcing = (
  config: LlmCallConfig,
  tools: ToolSchema[] | undefined,
): {
  forceToolChoice: ForceToolChoice | undefined;
  tools: ToolSchema[] | undefined;
  disableReasoning: boolean;
} => {
  const support: ForceToolChoiceSupport = config.forceToolChoiceSupport ?? 'full';
  const requested = config.forceToolChoice;
  const unforced = { forceToolChoice: undefined, tools, disableReasoning: false };

  if (!requested) return unforced;
  if (support === 'none') return unforced;
  if (support === 'reasoningDisabledOnly') {
    if (!config.needsForcedOutput) return unforced;
    return { forceToolChoice: requested, tools, disableReasoning: true };
  }
  if (support === 'anyToolOnly') {
    // The provider accepts "any" but not a named choice, so the only way to pin
    // the tool is to stop offering the others. An "any" request already means
    // that, so it needs no narrowing.
    if (requested === 'any' || !tools) return { forceToolChoice: requested, tools, disableReasoning: false };
    const only = tools.filter(tool => tool.name === requested.name);
    if (only.length === 0) throw new Error(`forceToolChoice names unknown tool ${requested.name}`);
    return { forceToolChoice: 'any', tools: only, disableReasoning: false };
  }
  return { forceToolChoice: requested, tools, disableReasoning: false };
};

export interface ToolSchema {
  name: string;
  description: string;
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
  /**
   * Whether this request actually constrained the model's choice. Callers that
   * enforce a forced call must use this rather than their own intent: a model
   * may be configured to drop the constraint (e.g. to keep its reasoning).
   *
   * Optional because test doubles stub this boundary without describing a wire
   * request; absent is read as "the constraint was applied", which is the
   * behaviour every stubbed call had before this field existed.
   */
  forceApplied?: boolean;
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
  if (config.forceToolChoice && (!tools || tools.length === 0))
    throw new Error('forceToolChoice requires at least one tool');
  const forcing = resolveForcing(config, tools);
  tools = forcing.tools;
  const forceToolChoice = forcing.forceToolChoice;
  const reasoningEffort = forcing.disableReasoning ? undefined : config.reasoningEffort;
  const disableReasoning = forcing.disableReasoning;
  const apiFormat = config.apiFormat;
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
      extraBody: config.extraBody, forceToolChoice, reasoningEffort, disableReasoning,
      onRequestBody: body => dumpLlmPayload(options.dumpId, 'request', body),
      log, label, timeoutSec: config.timeoutSec,
    });
    dumpLlmPayload(options.dumpId, 'response', response);

    const assistantItems = response.output.filter(item =>
      item.type === 'message' || item.type === 'function_call' || item.type === 'reasoning');
    return {
      entries: fromResponsesOutput(assistantItems),
      usage: response.usage,
      forceApplied: forceToolChoice != null,
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
      extraBody: config.extraBody, anthropicBetas: config.anthropicBetas,
      forceToolChoice, reasoningEffort, disableReasoning,
      onRequestBody: body => dumpLlmPayload(options.dumpId, 'request', body),
      log, label, timeoutSec: config.timeoutSec,
    });
    dumpLlmPayload(options.dumpId, 'response', response);

    return {
      entries: fromMessagesOutput(response.content),
      usage: response.usage,
      forceApplied: forceToolChoice != null,
    };
  }

  const chatMessages = await toChatCompletionsInput(prepared);
  const wireTools = optionalTools(tools?.map(toChatToolSchema));

  const response = await chatCompletions({
    baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
    messages: chatMessages, system, ...(wireTools ? { tools: wireTools } : {}),
    extraBody: config.extraBody, forceToolChoice, reasoningEffort, disableReasoning,
    onRequestBody: body => dumpLlmPayload(options.dumpId, 'request', body),
    log, label, timeoutSec: config.timeoutSec,
  });
  dumpLlmPayload(options.dumpId, 'response', response);

  const choice = response.choices[0];
  if (!choice) throw new Error('Chat Completions response contained no choices');

  return {
    entries: fromChatCompletionsOutput([choice.message as ChatCompletionsAssistantMessage]),
    usage: response.usage,
    forceApplied: forceToolChoice != null,
  };
};
