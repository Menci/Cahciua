import { mkdirSync, writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';
import type { Message, Tool } from 'xsai';

import { streamingChat } from './streaming';
import { isToolResult } from './tools';
import type { TRAssistantEntry, TRDataEntry, TRToolResultEntry } from './types';

const DUMP_DIR = '/tmp/cahciua';
mkdirSync(DUMP_DIR, { recursive: true });

type AnyMsg = Record<string, any>;

export interface RunnerConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}

export const createRunner = (config: RunnerConfig) => {
  const runStepLoop = async (params: {
    chatId: string;
    messages: Message[];
    system: string;
    tools: Tool[];
    maxSteps: number;
    onStepComplete: (stepData: TRDataEntry[], usage: { prompt_tokens: number; completion_tokens: number }, requestedAtMs: number) => void;
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

      // Capture timestamp BEFORE the API call so events arriving during
      // the (potentially slow) request have receivedAtMs > requestedAtMs
      // and won't be missed by the self-loop check on the next turn.
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
        // Model stayed silent — persist empty TR to advance lastTrTime
        params.log.withFields({ chatId: params.chatId, step }).log('Model chose to stay silent (no choices)');
        params.onStepComplete([], response.usage, stepRequestedAt);
        break;
      }

      const assistantMsg = choice.message as AnyMsg;
      const stepData: TRDataEntry[] = [assistantMsg as TRAssistantEntry];

      // Execute tools manually — we control this so every tool call and result
      // is visible in stepData and persisted in the TR.
      let anyRequiresFollowUp = false;
      if (assistantMsg.tool_calls?.length) {
        for (const tc of assistantMsg.tool_calls) {
          const tool = params.tools.find(t => t.function.name === tc.function.name);
          try {
            const args = JSON.parse(tc.function.arguments);
            const rawResult = tool
              ? await tool.execute(args, { messages: currentMessages, toolCallId: tc.id })
              : { error: `Unknown tool: ${tc.function.name}` };

            // Extract follow-up signal — tools returning ToolResult control loop continuation;
            // plain results (backward compat) default to requiring follow-up.
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
            // Errors always require follow-up (model should see the failure)
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

      // No tool calls -> model is done
      if (!assistantMsg.tool_calls?.length) break;

      // All tool calls opted out of follow-up — no need for another LLM round
      if (!anyRequiresFollowUp) {
        params.log.withFields({ chatId: params.chatId, step }).log('All tool calls completed without follow-up');
        break;
      }

      // Model wants to continue — check for interruption by new events.
      // The TR we just saved is already durable, so the next run will
      // include it along with the new events.
      if (params.checkInterrupt()) {
        params.log.withFields({ chatId: params.chatId, step }).log('Turn interrupted by new messages');
        break;
      }

      // No interruption — append step data and continue
      currentMessages = [...currentMessages, ...stepData] as Message[];
    }
  };

  return { runStepLoop };
};
