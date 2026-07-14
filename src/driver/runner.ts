import type { Logger } from '@guiiai/logg';

import type { CahciuaTool } from './tools';
import { executeToolCall, extractToolCalls, toToolSchema } from './tools';
import { runTurnLoop, type ExecutedStepResult, type ModelStepResult } from './turn-loop';
import { callLlm, type ForceToolChoice, type LlmCallConfig, type LlmCallUsage } from '../llm/call';
import type { ConversationEntry, ToolResult } from '../unified-api/types';

export interface RunnerConfig extends Omit<LlmCallConfig, 'forceToolChoice'> {}

interface CallModelStepParams {
  chatId: string;
  entries: ConversationEntry[];
  system: string;
  tools: CahciuaTool[];
  step: number;
  maxImagesAllowed?: number;
  forceToolChoice?: ForceToolChoice;
  log: Logger;
}

interface ExecuteToolStepParams {
  modelStep: ModelStepResult;
  tools: CahciuaTool[];
  log: Logger;
}

export interface StepLoopParams extends Omit<CallModelStepParams, 'entries' | 'step'> {
  entries: ConversationEntry[];
  maxSteps: number;
  onStepComplete: (
    stepEntries: ConversationEntry[],
    usage: LlmCallUsage,
    requestedAtMs: number,
  ) => void | Promise<void>;
  checkInterrupt: () => boolean;
}

const MAX_FORCE_TOOL_RETRIES = 3;

const addUsage = (left: LlmCallUsage, right: LlmCallUsage): LlmCallUsage => ({
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
  cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
});

export const createRunner = (config: RunnerConfig) => {
  const callModelStep = async (params: CallModelStepParams): Promise<ModelStepResult> => {
    const stepRequestedAt = Date.now();
    const toolSchemas = params.tools.map(toToolSchema);

    const invokeModel = () => callLlm(
      { ...config, forceToolChoice: params.forceToolChoice },
      params.entries,
      params.system,
      toolSchemas,
      {
        log: params.log,
        label: `step:${params.step}`,
        dumpId: params.chatId,
        maxImagesAllowed: params.maxImagesAllowed,
      },
    );

    let result = await invokeModel();
    let usage = { ...result.usage };

    if (params.forceToolChoice) {
      const choice = params.forceToolChoice;
      // Providers may ignore tool_choice. Rejected responses contribute usage,
      // but only the selected/final response can reach tool execution.
      const requirementMet = () => {
        const toolCalls = extractToolCalls(result.entries);
        return choice === 'any'
          ? toolCalls.length > 0
          : toolCalls.some(toolCall => toolCall.name === choice.name);
      };

      for (let retry = 1; retry <= MAX_FORCE_TOOL_RETRIES && !requirementMet(); retry++) {
        params.log.withFields({
          chatId: params.chatId,
          step: params.step,
          attempt: retry,
          maxRetries: MAX_FORCE_TOOL_RETRIES,
          forceToolChoice: choice,
        }).log('forceToolChoice: requirement not met, retrying');

        result = await invokeModel();
        usage = addUsage(usage, result.usage);
      }
      if (!requirementMet())
        throw new Error(`Model did not satisfy forced tool choice after ${MAX_FORCE_TOOL_RETRIES + 1} attempts`);
    }

    return {
      modelEntries: result.entries,
      usage,
      requestedAtMs: stepRequestedAt,
    };
  };

  const executeToolStep = async (params: ExecuteToolStepParams): Promise<ExecutedStepResult> => {
    const toolCalls = extractToolCalls(params.modelStep.modelEntries);
    const toolResults: ToolResult[] = [];
    for (const toolCall of toolCalls) {
      toolResults.push(await executeToolCall(
        toolCall.callId,
        toolCall.name,
        toolCall.args,
        params.tools,
        params.log,
      ));
    }

    return {
      stepEntries: [...params.modelStep.modelEntries, ...toolResults],
      usage: params.modelStep.usage,
      requestedAtMs: params.modelStep.requestedAtMs,
      hasToolCalls: toolCalls.length > 0,
    };
  };

  const runStepLoop = (params: StepLoopParams): Promise<void> => runTurnLoop(
    params,
    {
      callModelStep: (entries, step) => callModelStep({
        chatId: params.chatId,
        entries,
        system: params.system,
        tools: params.tools,
        step,
        maxImagesAllowed: params.maxImagesAllowed,
        forceToolChoice: params.forceToolChoice,
        log: params.log,
      }),
      executeToolStep: modelStep => executeToolStep({
        modelStep,
        tools: params.tools,
        log: params.log,
      }),
    },
  );

  return { runStepLoop };
};
