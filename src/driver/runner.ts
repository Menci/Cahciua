import type { Logger } from '@guiiai/logg';

import { callLlm, type ForceToolChoice, type LlmCallConfig, type LlmCallResult, type LlmCallUsage, type ToolSchema } from './call-llm';
import { ensureDumpDir } from './constants';
import type { CahciuaTool } from './tools';
import { executeToolCall, extractToolCalls } from './tools';
import type {
  ConversationEntry,
  ToolResult,
} from '../unified-api/types';

ensureDumpDir();

// RunnerConfig is the per-endpoint identity used as the runner cache key.
// Per-call concerns like forceToolChoice live on StepLoopParams so two chats
// using the same endpoint with different forceToolChoice settings can share
// a runner instance.
export interface RunnerConfig extends Omit<LlmCallConfig, 'forceToolChoice'> {}

interface StepLoopParams {
  chatId: string;
  entries: ConversationEntry[];
  system: string;
  tools: CahciuaTool[];
  maxSteps: number;
  maxImagesAllowed?: number;
  forceToolChoice?: ForceToolChoice;
  onStepComplete: (
    stepEntries: ConversationEntry[],
    usage: LlmCallUsage,
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
    usage: LlmCallUsage;
    requestedAtMs: number;
    hasToolCalls: boolean;
  }> => {
    const stepRequestedAt = Date.now();
    const toolSchemas = params.tools.map(toToolSchema);

    // tool_choice hints are not a hard constraint — models may ignore them.
    // When forceToolChoice is set, retry (capped) until the requirement is met:
    // 'any' → at least one tool call. {name} → that specific tool was called.
    const MAX_FORCE_TOOL_RETRIES = 3;
    const maxAttempts = params.forceToolChoice ? MAX_FORCE_TOOL_RETRIES + 1 : 1;

    let result!: LlmCallResult;
    let usage: LlmCallUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      result = await callLlm({ ...config, forceToolChoice: params.forceToolChoice }, workingEntries, params.system, toolSchemas, {
        log: params.log,
        label: `step:${step}`,
        dumpId: params.chatId,
        maxImagesAllowed: params.maxImagesAllowed,
      });

      usage = {
        inputTokens: usage.inputTokens + result.usage.inputTokens,
        outputTokens: usage.outputTokens + result.usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens + result.usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens + result.usage.cacheWriteTokens,
      };

      if (!params.forceToolChoice) break;
      const choice = params.forceToolChoice;
      const toolCallsThisAttempt = extractToolCalls(result.entries);
      const requirementMet = choice === 'any'
        ? toolCallsThisAttempt.length > 0
        : toolCallsThisAttempt.some(tc => tc.name === choice.name);
      if (requirementMet) break;
      if (attempt < MAX_FORCE_TOOL_RETRIES)
        params.log.withFields({
          chatId: params.chatId, step, attempt: attempt + 1, maxRetries: MAX_FORCE_TOOL_RETRIES,
          forceToolChoice: choice,
        }).log('forceToolChoice: requirement not met, retrying');
    }

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
