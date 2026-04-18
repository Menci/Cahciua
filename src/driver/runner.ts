import type { Logger } from '@guiiai/logg';

import { callLlm, type LlmCallConfig, type ToolSchema } from './call-llm';
import { ensureDumpDir } from './constants';
import type { CahciuaTool } from './tools';
import { executeToolCall, extractToolCalls } from './tools';
import type {
  ConversationEntry,
  ToolResult,
} from '../unified-api/types';

ensureDumpDir();

export interface RunnerConfig extends LlmCallConfig {}

interface StepLoopParams {
  chatId: string;
  entries: ConversationEntry[];
  system: string;
  tools: CahciuaTool[];
  maxSteps: number;
  maxImagesAllowed?: number;
  onStepComplete: (
    stepEntries: ConversationEntry[],
    usage: { prompt_tokens: number; completion_tokens: number },
    requestedAtMs: number,
  ) => void | Promise<void>;
  checkInterrupt: () => boolean;
  log: Logger;
}

const toToolSchema = (t: CahciuaTool): ToolSchema => ({
  name: t.function.name,
  parameters: t.function.parameters,
  ...(t.function.description ? { description: t.function.description } : {}),
});

export const createRunner = (config: RunnerConfig) => {
  const runOneStep = async (
    workingEntries: ConversationEntry[],
    params: StepLoopParams,
    step: number,
  ): Promise<{
    stepEntries: ConversationEntry[];
    usage: { prompt_tokens: number; completion_tokens: number };
    requestedAtMs: number;
    hasToolCalls: boolean;
  }> => {
    const stepRequestedAt = Date.now();
    const toolSchemas = params.tools.map(toToolSchema);

    const result = await callLlm(config, workingEntries, params.system, toolSchemas, {
      log: params.log,
      label: `step:${step}`,
      dumpId: params.chatId,
      maxImagesAllowed: params.maxImagesAllowed,
    });

    const usage = {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
    };

    if (result.entries.length === 0)
      return { stepEntries: [], usage, requestedAtMs: stepRequestedAt, hasToolCalls: false };

    const toolCalls = extractToolCalls(result.entries);
    const toolResults: ToolResult[] = [];
    for (const tc of toolCalls)
      toolResults.push(await executeToolCall(tc.callId, tc.name, tc.args, params.tools, params.log));

    return {
      stepEntries: [...result.entries, ...toolResults],
      usage,
      requestedAtMs: stepRequestedAt,
      hasToolCalls: toolCalls.length > 0,
    };
  };

  const runStepLoop = async (params: StepLoopParams): Promise<void> => {
    let working: ConversationEntry[] = [...params.entries];

    for (let step = 1; step <= params.maxSteps; step++) {
      const { stepEntries, usage, requestedAtMs, hasToolCalls } =
        await runOneStep(working, params, step);

      if (stepEntries.length === 0) {
        params.log.withFields({ chatId: params.chatId, step }).log('Model chose to stay silent');
        await params.onStepComplete([], usage, requestedAtMs);
        break;
      }

      const toolResults = stepEntries.filter((e): e is ToolResult => e.kind === 'toolResult');
      const anyRequiresFollowUp = toolResults.some(tr => tr.requiresFollowUp);

      params.log.withFields({
        chatId: params.chatId, step,
        hasToolCalls, newEntries: stepEntries.length, usage,
      }).log('Step completed');

      await params.onStepComplete(stepEntries, usage, requestedAtMs);

      if (!hasToolCalls || !anyRequiresFollowUp) {
        if (hasToolCalls && !anyRequiresFollowUp)
          params.log.withFields({ chatId: params.chatId, step }).log('All tool calls completed without follow-up');
        break;
      }
      if (params.checkInterrupt()) {
        params.log.withFields({ chatId: params.chatId, step }).log('Turn interrupted by new messages');
        break;
      }

      working = [...working, ...stepEntries];
    }
  };

  return { runStepLoop };
};
