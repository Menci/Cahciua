import type { Logger } from '@guiiai/logg';

import { composeContext, composeProbeContext, injectLateBindingPrompt, latestExternalEventMs, loopEndedWithoutSendMessage, wasToolLoopInterrupted } from './context';
import { renderLateBindingPrompt, renderSystemPrompt } from './prompt';
import type { createRunner } from './runner';
import { createDecideTool, extractDecideResult, toToolSchema } from './tools';
import type { CahciuaTool } from './tools';
import type { ProbeResponseV2, ResolvedChatConfig, TurnResponseV2 } from './types';
import type { ActiveTaskInfo } from '../background-task/types';
import { callLlm } from '../llm/call';
import type { RenderedContext } from '../rendering/types';

const localTimeNow = (): string => {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (value: number): string => String(Math.abs(value)).padStart(2, '0');
  const timezone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 19);
  return `${local}${timezone}`;
};

export const executeWakeup = async (params: {
  chatId: string;
  chatConfig: ResolvedChatConfig;
  contextAtStart: RenderedContext;
  currentContext: () => RenderedContext;
  cursorMs?: number;
  summary?: string;
  loadTurnResponses: (chatId: string, afterMs?: number) => Promise<TurnResponseV2[]>;
  persistTurnResponse: (chatId: string, response: TurnResponseV2) => Promise<void>;
  persistProbeResponse: (chatId: string, response: ProbeResponseV2) => Promise<void>;
  getChatTitle: (chatId: string) => string | undefined;
  getActiveBackgroundTasks: (chatId: string) => ActiveTaskInfo[];
  sendTypingAction: (chatId: string) => Promise<void>;
  createTools: () => CahciuaTool[];
  runner: Pick<ReturnType<typeof createRunner>, 'runStepLoop'>;
  getLastProcessedMs: () => number;
  setLastProcessedMs: (value: number) => void;
  log: Logger;
}): Promise<void> => {
  const turnResponses = await params.loadTurnResponses(params.chatId, params.cursorMs);
  const primaryContext = composeContext(
    params.contextAtStart,
    turnResponses,
    params.chatConfig.compaction.maxContextEstTokens,
    params.chatConfig.primary.model.model,
    params.summary,
  );
  if (!primaryContext) return;

  params.log.withFields({
    chatId: params.chatId,
    entries: primaryContext.entries.length,
    estimatedTokens: primaryContext.estimatedTokens,
  }).log('Triggering LLM call');

  const interrupted = wasToolLoopInterrupted(turnResponses);
  const backgroundTasks = params.getActiveBackgroundTasks(params.chatId);
  const timeNow = localTimeNow();
  let probeReason: string | undefined;

  if (!interrupted) {
    params.log.withFields({
      chatId: params.chatId,
      lastProcessedMs: params.getLastProcessedMs(),
    }).log('Running probe');
    const probeContext = composeProbeContext(
      params.contextAtStart,
      turnResponses,
      params.chatConfig.compaction.maxContextEstTokens,
      params.summary,
    );
    if (!probeContext) return;

    const system = await renderSystemPrompt({
      mode: 'probe',
      currentChannel: 'telegram',
      modelName: params.chatConfig.probe.model.model,
      chatId: params.chatId,
      chatTitle: params.getChatTitle(params.chatId),
      systemFiles: params.chatConfig.systemFiles,
    });
    const entries = [...probeContext.entries];
    injectLateBindingPrompt(entries, await renderLateBindingPrompt({
      mode: 'probe',
      timeNow,
      activeBackgroundTasks: backgroundTasks,
    }));

    const decideTool = createDecideTool();
    const requestedAtMs = Date.now();
    const result = await callLlm(
      { ...params.chatConfig.probe.model, forceToolChoice: { name: 'decide' } },
      entries,
      system,
      [decideTool].map(toToolSchema),
      {
        log: params.log,
        label: `probe:${params.chatId}`,
        dumpId: `${params.chatId}.probe`,
        maxImagesAllowed: params.chatConfig.probe.model.maxImagesAllowed,
      },
    );
    const decision = extractDecideResult(result.entries);
    const activated = decision?.should_act === 'send_message';
    params.log.withFields({
      chatId: params.chatId,
      shouldAct: activated,
      reason: decision?.reason,
    }).log('Probe result');
    await params.persistProbeResponse(params.chatId, {
      requestedAtMs,
      entries: result.entries,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      modelName: params.chatConfig.probe.model.model,
      isActivated: activated,
      createdAt: Date.now(),
    });
    params.setLastProcessedMs(requestedAtMs);
    if (!activated) return;
    probeReason = decision.reason;
  }

  let typingInterval: ReturnType<typeof setInterval> | undefined;
  const sendTyping = (): void => {
    void params.sendTypingAction(params.chatId).catch(error =>
      params.log.withError(error).withFields({ chatId: params.chatId }).debug('Typing action failed'));
  };
  if (params.chatConfig.sendTypingAction) {
    sendTyping();
    typingInterval = setInterval(() => {
      sendTyping();
    }, 5000);
  }

  try {
    const system = await renderSystemPrompt({
      mode: 'primary',
      currentChannel: 'telegram',
      modelName: params.chatConfig.primary.model.model,
      chatId: params.chatId,
      chatTitle: params.getChatTitle(params.chatId),
      systemFiles: params.chatConfig.systemFiles,
    });
    injectLateBindingPrompt(primaryContext.entries, await renderLateBindingPrompt({
      mode: 'primary',
      timeNow,
      isInterrupted: interrupted,
      activeBackgroundTasks: backgroundTasks,
      ...(probeReason ? { probeReason } : {}),
    }));
    const tools = params.createTools();

    const persistStep = async (
      entries: TurnResponseV2['entries'],
      usage: Pick<TurnResponseV2, 'cacheReadTokens' | 'cacheWriteTokens' | 'inputTokens' | 'outputTokens'>,
      requestedAtMs: number,
    ): Promise<void> => {
      await params.persistTurnResponse(params.chatId, {
        requestedAtMs,
        entries,
        ...usage,
        modelName: params.chatConfig.primary.model.model,
      });
      params.setLastProcessedMs(requestedAtMs);
    };

    await params.runner.runStepLoop({
      chatId: params.chatId,
      entries: primaryContext.entries,
      system,
      tools,
      maxSteps: Infinity,
      maxImagesAllowed: params.chatConfig.primary.model.maxImagesAllowed,
      forceToolChoice: 'any',
      onStepComplete: persistStep,
      checkInterrupt: () =>
        params.currentContext() !== params.contextAtStart
        && latestExternalEventMs(params.currentContext(), params.getLastProcessedMs()) != null,
      log: params.log,
    });

    const latestTurnResponses = await params.loadTurnResponses(params.chatId, params.cursorMs);
    if (loopEndedWithoutSendMessage(latestTurnResponses)) {
      params.log.withFields({ chatId: params.chatId }).log('Loop ended without send_message — running forced fallback');
      await params.runner.runStepLoop({
        chatId: params.chatId,
        entries: primaryContext.entries,
        system,
        tools,
        maxSteps: 1,
        maxImagesAllowed: params.chatConfig.primary.model.maxImagesAllowed,
        forceToolChoice: { name: 'send_message' },
        onStepComplete: persistStep,
        checkInterrupt: () => false,
        log: params.log,
      });
    }
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }
};
