import { mkdirSync, writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';
import type { Message, Tool } from 'xsai';

import { messagesToResponsesInput, responsesOutputToMessages } from './convert';
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

export const createRunner = (config: RunnerConfig) => {
  const apiFormat = config.apiFormat ?? 'openai-chat';

  const runStepLoop = async (params: {
    chatId: string;
    messages: Message[];
    system: string;
    tools: Tool[];
    maxSteps: number;
    onStepComplete: (stepData: unknown[], usage: { prompt_tokens: number; completion_tokens: number }, requestedAtMs: number) => void;
    checkInterrupt: () => boolean;
    log: Logger;
  }): Promise<void> => {
    if (apiFormat === 'responses') {
      await runStepLoopResponses(params);
    } else {
      await runStepLoopChat(params);
    }
  };

  // ── openai-chat step loop (existing logic) ──
  const runStepLoopChat = async (params: {
    chatId: string;
    messages: Message[];
    system: string;
    tools: Tool[];
    maxSteps: number;
    onStepComplete: (stepData: unknown[], usage: { prompt_tokens: number; completion_tokens: number }, requestedAtMs: number) => void;
    checkInterrupt: () => boolean;
    log: Logger;
  }): Promise<void> => {
    let currentMessages = params.messages;
    let step = 0;

    while (step < params.maxSteps) {
      step++;

      writeFileSync(`${DUMP_DIR}/${params.chatId}.request.json`, JSON.stringify({
        model: config.model,
        system: params.system,
        messages: currentMessages,
        tools: params.tools.map(t => ({ type: t.type, function: t.function })),
      }, null, 2));

      const stepRequestedAt = Date.now();

      const response = await streamingChat({
        baseURL: config.apiBaseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages: currentMessages,
        system: params.system,
        tools: params.tools,
        log: params.log,
        label: `step:${step}`,
      });
      const choice = response.choices[0];

      if (!choice) {
        params.log.withFields({ chatId: params.chatId, step }).log('Model chose to stay silent (no choices)');
        params.onStepComplete([], response.usage, stepRequestedAt);
        break;
      }

      const assistantMsg = choice.message as AnyMsg;
      const stepData: TRDataEntry[] = [assistantMsg as TRAssistantEntry];

      let anyRequiresFollowUp = false;
      if (assistantMsg.tool_calls?.length) {
        for (const tc of assistantMsg.tool_calls) {
          const tool = params.tools.find(t => t.function.name === tc.function.name);
          try {
            const args = JSON.parse(tc.function.arguments);
            const rawResult = tool
              ? await tool.execute(args, { messages: currentMessages, toolCallId: tc.id })
              : { error: `Unknown tool: ${tc.function.name}` };

            const { content, requiresFollowUp } = isToolResult(rawResult)
              ? rawResult
              : { content: rawResult, requiresFollowUp: true };
            if (requiresFollowUp) anyRequiresFollowUp = true;

            const toolResult: TRToolResultEntry = {
              role: 'tool',
              tool_call_id: tc.id,
              content: typeof content === 'string' ? content : JSON.stringify(content),
            };
            stepData.push(toolResult);
          } catch (err) {
            anyRequiresFollowUp = true;
            params.log.withError(err).error(`Tool ${tc.function.name} failed`);
            const toolResult: TRToolResultEntry = {
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ error: String(err) }),
            };
            stepData.push(toolResult);
          }
        }
      }

      params.log.withFields({
        chatId: params.chatId,
        step,
        finishReason: choice.finish_reason,
        hasToolCalls: !!assistantMsg.tool_calls?.length,
        newMessages: stepData.length,
        usage: response.usage,
      }).log('Step completed');

      params.onStepComplete(stepData, response.usage, stepRequestedAt);

      if (!assistantMsg.tool_calls?.length) break;
      if (!anyRequiresFollowUp) {
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

  // ── responses step loop ──
  const runStepLoopResponses = async (params: {
    chatId: string;
    messages: Message[];
    system: string;
    tools: Tool[];
    maxSteps: number;
    onStepComplete: (stepData: unknown[], usage: { prompt_tokens: number; completion_tokens: number }, requestedAtMs: number) => void;
    checkInterrupt: () => boolean;
    log: Logger;
  }): Promise<void> => {
    // Convert openai-chat Messages to Responses API input
    let currentInput = messagesToResponsesInput(params.messages);
    // Track Messages for tool.execute context (mirrors openai-chat path)
    let currentMessages = [...params.messages];
    let step = 0;

    const responsesTools = params.tools.map(t => ({
      type: 'function' as const,
      name: t.function.name,
      parameters: t.function.parameters as Record<string, unknown>,
      ...(t.function.description ? { description: t.function.description } : {}),
    }));

    while (step < params.maxSteps) {
      step++;

      writeFileSync(`${DUMP_DIR}/${params.chatId}.request.json`, JSON.stringify({
        model: config.model,
        instructions: params.system,
        input: currentInput,
        tools: responsesTools,
      }, null, 2));

      const stepRequestedAt = Date.now();

      const response = await streamingResponses({
        baseURL: config.apiBaseUrl,
        apiKey: config.apiKey,
        model: config.model,
        input: currentInput,
        instructions: params.system,
        tools: responsesTools,
        log: params.log,
        label: `step:${step}`,
      });

      if (response.output.length === 0) {
        params.log.withFields({ chatId: params.chatId, step }).log('Model chose to stay silent (no output)');
        params.onStepComplete([], { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens }, stepRequestedAt);
        break;
      }

      // stepData = the raw output items (stored as-is in TR)
      const stepData: unknown[] = [...response.output];

      // Extract function calls
      const functionCalls = response.output.filter(
        (item): item is ResponseOutputFunctionCall => item.type === 'function_call',
      );

      let anyRequiresFollowUp = false;
      const callOutputs: ResponseFunctionCallOutputItem[] = [];

      if (functionCalls.length > 0) {
        for (const fc of functionCalls) {
          const tool = params.tools.find(t => t.function.name === fc.name);
          try {
            const args = JSON.parse(fc.arguments);
            const rawResult = tool
              ? await tool.execute(args, { messages: currentMessages, toolCallId: fc.call_id })
              : { error: `Unknown tool: ${fc.name}` };

            const { content, requiresFollowUp } = isToolResult(rawResult)
              ? rawResult
              : { content: rawResult, requiresFollowUp: true };
            if (requiresFollowUp) anyRequiresFollowUp = true;

            callOutputs.push({
              type: 'function_call_output',
              call_id: fc.call_id,
              output: typeof content === 'string' ? content : JSON.stringify(content),
            });
          } catch (err) {
            anyRequiresFollowUp = true;
            params.log.withError(err).error(`Tool ${fc.name} failed`);
            callOutputs.push({
              type: 'function_call_output',
              call_id: fc.call_id,
              output: JSON.stringify({ error: String(err) }),
            });
          }
        }

        // Add call outputs to stepData for persistence
        stepData.push(...callOutputs);
      }

      params.log.withFields({
        chatId: params.chatId,
        step,
        status: response.status,
        hasToolCalls: functionCalls.length > 0,
        outputItems: response.output.length,
        usage: response.usage,
      }).log('Step completed');

      params.onStepComplete(stepData, { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens }, stepRequestedAt);

      if (functionCalls.length === 0) break;
      if (!anyRequiresFollowUp) {
        params.log.withFields({ chatId: params.chatId, step }).log('All tool calls completed without follow-up');
        break;
      }
      if (params.checkInterrupt()) {
        params.log.withFields({ chatId: params.chatId, step }).log('Turn interrupted by new messages');
        break;
      }

      // Append output + call outputs to input for next step
      currentInput = [...currentInput, ...response.output as any[], ...callOutputs as any[]];
      currentMessages = [...currentMessages, ...responsesOutputToMessages([...response.output, ...callOutputs])];
    }
  };

  return { runStepLoop };
};
