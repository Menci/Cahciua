import { mkdirSync, writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';
import type { Message, Tool } from 'xsai';

import { messagesToResponsesInput, responsesOutputToMessages, xsaiToolToResponsesTool } from './convert';
import type { ResponseFunctionCallOutputItem, ResponseOutputFunctionCall } from './responses-types';
import { streamingChat } from './streaming';
import { streamingResponses } from './streaming-responses';
import { isToolResult } from './tools';
import type { ProviderFormat, TRAssistantEntry, TRDataEntry, TRToolResultEntry } from './types';

const DUMP_DIR = '/tmp/cahciua';
mkdirSync(DUMP_DIR, { recursive: true });

type AnyMsg = Record<string, any>;

export interface RunnerConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ProviderFormat;
}

interface StepLoopParams {
  chatId: string;
  messages: Message[];
  system: string;
  tools: Tool[];
  maxSteps: number;
  onStepComplete: (stepData: unknown[], usage: { prompt_tokens: number; completion_tokens: number }, requestedAtMs: number) => void;
  checkInterrupt: () => boolean;
  log: Logger;
}

// Execute a tool call and return { id, output, requiresFollowUp }.
// Shared by both openai-chat and responses step loops.
const executeToolCall = async (
  id: string, name: string, args: string,
  tools: Tool[], messages: Message[], log: Logger,
): Promise<{ id: string; output: string; requiresFollowUp: boolean }> => {
  const tool = tools.find(t => t.function.name === name);
  try {
    const parsed = JSON.parse(args);
    const rawResult = tool
      ? await tool.execute(parsed, { messages, toolCallId: id })
      : { error: `Unknown tool: ${name}` };
    const { content, requiresFollowUp } = isToolResult(rawResult)
      ? rawResult
      : { content: rawResult, requiresFollowUp: true };
    return { id, output: typeof content === 'string' ? content : JSON.stringify(content), requiresFollowUp };
  } catch (err) {
    log.withError(err).error(`Tool ${name} failed`);
    return { id, output: JSON.stringify({ error: String(err) }), requiresFollowUp: true };
  }
};

export const createRunner = (config: RunnerConfig) => {
  const apiFormat = config.apiFormat ?? 'openai-chat';

  const runStepLoop = async (params: StepLoopParams): Promise<void> => {
    apiFormat === 'responses'
      ? await runStepLoopResponses(params)
      : await runStepLoopChat(params);
  };

  const runStepLoopChat = async (params: StepLoopParams): Promise<void> => {
    let currentMessages = params.messages;

    for (let step = 1; step <= params.maxSteps; step++) {
      writeFileSync(`${DUMP_DIR}/${params.chatId}.request.json`, JSON.stringify({
        model: config.model, system: params.system, messages: currentMessages,
        tools: params.tools.map(t => ({ type: t.type, function: t.function })),
      }, null, 2));

      const stepRequestedAt = Date.now();
      const response = await streamingChat({
        baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
        messages: currentMessages, system: params.system, tools: params.tools,
        log: params.log, label: `step:${step}`,
      });

      const choice = response.choices[0];
      if (!choice) {
        params.log.withFields({ chatId: params.chatId, step }).log('Model chose to stay silent (no choices)');
        params.onStepComplete([], response.usage, stepRequestedAt);
        break;
      }

      const assistantMsg = choice.message as AnyMsg;
      const stepData: TRDataEntry[] = [assistantMsg as TRAssistantEntry];
      const toolCalls = assistantMsg.tool_calls ?? [];

      let anyRequiresFollowUp = false;
      for (const tc of toolCalls) {
        const result = await executeToolCall(tc.id, tc.function.name, tc.function.arguments, params.tools, currentMessages, params.log);
        anyRequiresFollowUp ||= result.requiresFollowUp;
        stepData.push({ role: 'tool', tool_call_id: tc.id, content: result.output } as TRToolResultEntry);
      }

      params.log.withFields({
        chatId: params.chatId, step, finishReason: choice.finish_reason,
        hasToolCalls: toolCalls.length > 0, newMessages: stepData.length, usage: response.usage,
      }).log('Step completed');

      params.onStepComplete(stepData, response.usage, stepRequestedAt);

      if (!toolCalls.length || !anyRequiresFollowUp) {
        if (toolCalls.length && !anyRequiresFollowUp)
          params.log.withFields({ chatId: params.chatId, step }).log('All tool calls completed without follow-up');
        break;
      }
      if (params.checkInterrupt()) {
        params.log.withFields({ chatId: params.chatId, step }).log('Turn interrupted by new messages');
        break;
      }

      currentMessages = [...currentMessages, ...stepData] as Message[];
    }
  };

  const runStepLoopResponses = async (params: StepLoopParams): Promise<void> => {
    let currentInput = messagesToResponsesInput(params.messages);
    let currentMessages = [...params.messages];
    const responsesTools = params.tools.map(xsaiToolToResponsesTool);

    for (let step = 1; step <= params.maxSteps; step++) {
      writeFileSync(`${DUMP_DIR}/${params.chatId}.request.json`, JSON.stringify({
        model: config.model, instructions: params.system, input: currentInput, tools: responsesTools,
      }, null, 2));

      const stepRequestedAt = Date.now();
      const response = await streamingResponses({
        baseURL: config.apiBaseUrl, apiKey: config.apiKey, model: config.model,
        input: currentInput, instructions: params.system, tools: responsesTools,
        log: params.log, label: `step:${step}`,
      });

      if (response.output.length === 0) {
        params.log.withFields({ chatId: params.chatId, step }).log('Model chose to stay silent (no output)');
        params.onStepComplete([], { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens }, stepRequestedAt);
        break;
      }

      const stepData: unknown[] = [...response.output];
      const functionCalls = response.output.filter((item): item is ResponseOutputFunctionCall => item.type === 'function_call');
      const callOutputs: ResponseFunctionCallOutputItem[] = [];

      let anyRequiresFollowUp = false;
      for (const fc of functionCalls) {
        const result = await executeToolCall(fc.call_id, fc.name, fc.arguments, params.tools, currentMessages, params.log);
        anyRequiresFollowUp ||= result.requiresFollowUp;
        callOutputs.push({ type: 'function_call_output', call_id: fc.call_id, output: result.output });
      }
      stepData.push(...callOutputs);

      params.log.withFields({
        chatId: params.chatId, step, status: response.status,
        hasToolCalls: functionCalls.length > 0, outputItems: response.output.length, usage: response.usage,
      }).log('Step completed');

      params.onStepComplete(stepData, { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens }, stepRequestedAt);

      if (!functionCalls.length || !anyRequiresFollowUp) {
        if (functionCalls.length && !anyRequiresFollowUp)
          params.log.withFields({ chatId: params.chatId, step }).log('All tool calls completed without follow-up');
        break;
      }
      if (params.checkInterrupt()) {
        params.log.withFields({ chatId: params.chatId, step }).log('Turn interrupted by new messages');
        break;
      }

      currentInput = [...currentInput, ...response.output as any[], ...callOutputs as any[]];
      currentMessages = [...currentMessages, ...responsesOutputToMessages([...response.output, ...callOutputs])];
    }
  };

  return { runStepLoop };
};
