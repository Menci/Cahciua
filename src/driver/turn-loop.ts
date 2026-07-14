import type { Logger } from '@guiiai/logg';

import type { LlmCallUsage } from '../llm/call';
import type { ConversationEntry, ToolResult } from '../unified-api/types';

export interface ModelStepResult {
  modelEntries: ConversationEntry[];
  usage: LlmCallUsage;
  requestedAtMs: number;
}

export interface ExecutedStepResult {
  stepEntries: ConversationEntry[];
  usage: LlmCallUsage;
  requestedAtMs: number;
  hasToolCalls: boolean;
}

export interface TurnLoopOperations {
  callModelStep: (
    workingEntries: ConversationEntry[],
    step: number,
  ) => Promise<ModelStepResult>;
  executeToolStep: (modelStep: ModelStepResult) => Promise<ExecutedStepResult>;
}

export interface TurnLoopParams {
  chatId: string;
  entries: ConversationEntry[];
  maxSteps: number;
  onStepComplete: (
    stepEntries: ConversationEntry[],
    usage: LlmCallUsage,
    requestedAtMs: number,
  ) => void | Promise<void>;
  checkInterrupt: () => boolean;
  log: Logger;
}

export const runTurnLoop = async (
  params: TurnLoopParams,
  operations: TurnLoopOperations,
): Promise<void> => {
  let workingEntries = [...params.entries];

  for (let step = 1; step <= params.maxSteps; step++) {
    const modelStep = await operations.callModelStep(workingEntries, step);
    const { stepEntries, usage, requestedAtMs, hasToolCalls }
      = await operations.executeToolStep(modelStep);

    const toolResults = stepEntries.filter((entry): entry is ToolResult => entry.kind === 'toolResult');
    const anyRequiresFollowUp = toolResults.some(result => result.requiresFollowUp);

    params.log.withFields({
      chatId: params.chatId,
      step,
      hasToolCalls,
      newEntries: stepEntries.length,
      usage,
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

    workingEntries = [...workingEntries, ...stepEntries];
  }
};
