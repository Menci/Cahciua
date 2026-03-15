import type { Logger } from '@guiiai/logg';
import { computed, effect, signal } from 'alien-signals';
import type { Message } from 'xsai';

import { runCompaction } from './compaction';
import { composeContext, findWorkingWindowCursor, latestExternalEventMs, trimImages } from './context';
import { messagesToResponsesInput } from './convert';
import { renderLateBindingPrompt, renderSystemPrompt } from './prompt';
import type { ResponseOutputFunctionCall } from './responses-types';
import { createRunner } from './runner';
import { streamingChat } from './streaming';
import { streamingResponses } from './streaming-responses';
import { createSendMessageTool } from './tools';
import type { CompactionSessionMeta, DriverConfig, ProviderFormat, TurnResponse } from './types';
import type { RenderedContext } from '../rendering/types';

export { mergeContext } from './merge';
export { renderLateBindingPrompt, renderSystemPrompt } from './prompt';
export type { DriverConfig, ProviderFormat, TurnResponse } from './types';

const MAX_STEPS = 5;

// Append late-binding prompt as a separate user message at the end.
// Preserves KV cache for system prompt and prior messages.
const injectLateBindingPrompt = (messages: Message[], prompt: string): void => {
  messages.push({ role: 'user', content: prompt } as Message);
};

export const createDriver = (config: DriverConfig, deps: {
  loadTurnResponses: (chatId: string, afterMs?: number) => TurnResponse[];
  persistTurnResponse: (chatId: string, tr: TurnResponse) => void;
  persistProbeResponse: (chatId: string, probe: {
    requestedAtMs: number;
    provider: string;
    data: Record<string, any>[];
    inputTokens: number;
    outputTokens: number;
    reasoningSignatureCompat: string;
    isActivated: boolean;
  }) => void;
  sendMessage: (chatId: string, text: string, replyToMessageId?: number) => Promise<{ messageId: number; date: number }>;
  loadCompaction: (chatId: string) => CompactionSessionMeta | null;
  loadLastProbeTime: (chatId: string) => number;
  persistCompaction: (chatId: string, meta: CompactionSessionMeta) => void;
  setCompactCursor: (chatId: string, cursorMs: number) => RenderedContext | undefined;
  logger: Logger;
}) => {
  const { logger } = deps;
  const log = logger.withContext('driver');
  const chatIds = new Set(config.chatIds);

  const primaryApiFormat: ProviderFormat = config.primaryModel.apiFormat ?? 'openai-chat';

  const runner = createRunner({
    apiBaseUrl: config.primaryModel.apiBaseUrl,
    apiKey: config.primaryModel.apiKey,
    model: config.primaryModel.model,
    apiFormat: primaryApiFormat,
  });

  const loadTRs = (chatId: string, afterMs?: number): TurnResponse[] =>
    deps.loadTurnResponses(chatId, afterMs);

  const getLastProcessedTime = (chatId: string): number => {
    const trs = deps.loadTurnResponses(chatId);
    const lastTr = trs.length > 0 ? trs[trs.length - 1]!.requestedAtMs : 0;
    const lastProbe = deps.loadLastProbeTime(chatId);
    return Math.max(lastTr, lastProbe);
  };

  const chatScopes = new Map<string, {
    rc: ReturnType<typeof signal<RenderedContext>>;
    cleanup: () => void;
  }>();

  const getOrCreateScope = (chatId: string) => {
    const existing = chatScopes.get(chatId);
    if (existing) return existing;

    const rc = signal<RenderedContext>([]);
    const lastProcessedMs = signal(getLastProcessedTime(chatId));
    const running = signal(false);
    const failedRc = signal<RenderedContext | null>(null);
    let timer: ReturnType<typeof setTimeout> | undefined;

    // --- Compaction state as signal ---
    // Initialized from DB on scope creation (cold start). Updated by the
    // compaction effect when it completes. Read by the reply effect to
    // get cursor + summary. No runtime DB queries.
    const compactionMeta = signal<CompactionSessionMeta | null>(
      deps.loadCompaction(chatId),
    );

    // Derived values for convenience
    const cursorMs = computed(() => compactionMeta()?.newCursorMs);
    const summary = computed(() => compactionMeta()?.summary);

    // --- Auto-apply cursor to pipeline when compaction state changes ---
    // When compactionMeta updates (from cold start init or compaction completion),
    // tell the pipeline to re-render RC excluding nodes before the cursor.
    const disposeCursorEffect = effect(() => {
      const cursor = cursorMs();
      if (cursor == null) return;
      const newRC = deps.setCompactCursor(chatId, cursor);
      if (newRC) rc(newRC);
    });

    // --- Main LLM reply effect ---
    // Triggers immediately when new external messages arrive (no debounce).
    // Natural batching: `running` prevents concurrent calls, so messages
    // arriving during an LLM call accumulate and get picked up on the next run.
    const needsReply = computed(() => {
      const rcVal = rc();
      if (rcVal.length === 0) return false;
      if (rcVal === failedRc()) return false;
      return latestExternalEventMs(rcVal, lastProcessedMs()) != null;
    });

    const disposeReplyEffect = effect(() => {
      const isRunning = running();
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (isRunning) return;

      if (!needsReply()) return;

      // setTimeout(0) to exit the synchronous signal graph before starting async work
      timer = setTimeout(() => {
        const rcAtStart = rc();
        running(true);

        void (async () => {
          try {
            // Read compaction state from signal — no DB query.
            const cursor = cursorMs();
            const sum = summary();

            const trs = loadTRs(chatId, cursor);
            const ctx = composeContext(rc(), trs, config.compaction.maxContextEstTokens, config.primaryModel.reasoningSignatureCompat, config.featureFlags, sum);
            if (!ctx) return;

            log.withFields({
              chatId,
              messages: ctx.messages.length,
              estimatedTokens: ctx.estimatedTokens,
            }).log('Triggering LLM call');

            const sendMessageTool = createSendMessageTool(async (text, replyTo) => {
              log.withFields({
                chatId,
                text: text.length > 100 ? `${text.slice(0, 100)}...` : text,
                replyTo,
              }).log('send_message tool called');
              const sent = await deps.sendMessage(chatId, text, replyTo ? Number(replyTo) : undefined);
              return { messageId: String(sent.messageId) };
            });

            const system = await renderSystemPrompt({
              currentChannel: 'telegram',
              timeNow: new Date().toISOString(),
            });

            // --- Compute mention/reply state from RC ---
            const rcVal = rc();
            const lastMentionedAtMs = rcVal.reduce((max, seg) =>
              (seg.mentionsMe || seg.repliesToMe) ? Math.max(max, seg.receivedAtMs) : max, 0);
            const isMentioned = rcVal.some(seg => seg.mentionsMe && seg.receivedAtMs > lastProcessedMs());
            const isReplied = rcVal.some(seg => seg.repliesToMe && seg.receivedAtMs > lastProcessedMs());

            // --- Probe gate ---
            // In group chats, if the bot was not recently @'d or replied to, use a
            // small/cheap probe model to decide whether to respond. If the probe
            // chooses silence (no tool calls), we skip the primary model entirely.
            if (config.probe.enabled) {
              const needsProbe = lastMentionedAtMs <= lastProcessedMs();

              if (needsProbe) {
                log.withFields({ chatId, lastMentionedAtMs, lastProcessedMs: lastProcessedMs() }).log('Running probe');

                // Probe may have stricter image limits — trim a shallow copy
                const probeMessages = ctx.messages.map(m => {
                  const a = m as Record<string, any>;
                  return Array.isArray(a.content) ? { ...m, content: [...a.content] } : m;
                });
                if (config.probe.model.maxImagesAllowed != null)
                  trimImages(probeMessages, config.probe.model.maxImagesAllowed);

                const probeLateBinding = await renderLateBindingPrompt({
                  isProbeEnabled: true, isProbing: true, isMentioned, isReplied,
                });
                injectLateBindingPrompt(probeMessages, probeLateBinding);

                // Capture before probe call — events arriving during the call
                // have receivedAtMs > probeRequestedAt and won't be swallowed.
                const probeRequestedAt = Date.now();

                const probeApiFormat: ProviderFormat = config.probe.model.apiFormat ?? 'openai-chat';
                let hasToolCalls = false;
                let probeData: Record<string, any>[] = [];
                let probeInputTokens = 0;
                let probeOutputTokens = 0;

                if (probeApiFormat === 'responses') {
                  const probeResult = await streamingResponses({
                    baseURL: config.probe.model.apiBaseUrl,
                    apiKey: config.probe.model.apiKey,
                    model: config.probe.model.model,
                    input: messagesToResponsesInput(probeMessages),
                    instructions: system,
                    tools: [sendMessageTool].map(t => ({
                      type: 'function' as const,
                      name: t.function.name,
                      parameters: t.function.parameters as Record<string, unknown>,
                      ...(t.function.description ? { description: t.function.description } : {}),
                    })),
                    log,
                    label: `probe:${chatId}`,
                  });

                  const functionCalls = probeResult.output.filter(
                    (item): item is ResponseOutputFunctionCall => item.type === 'function_call',
                  );
                  hasToolCalls = functionCalls.length > 0;
                  probeData = probeResult.output as Record<string, any>[];
                  probeInputTokens = probeResult.usage.input_tokens;
                  probeOutputTokens = probeResult.usage.output_tokens;

                  log.withFields({
                    chatId,
                    hasToolCalls,
                    toolCalls: functionCalls.map(fc => ({ name: fc.name, args: fc.arguments })),
                    outputItems: probeResult.output.length,
                    usage: probeResult.usage,
                  }).log('Probe result');
                } else {
                  const probeResult = await streamingChat({
                    baseURL: config.probe.model.apiBaseUrl,
                    apiKey: config.probe.model.apiKey,
                    model: config.probe.model.model,
                    messages: probeMessages,
                    system,
                    tools: [sendMessageTool],
                    log,
                    label: `probe:${chatId}`,
                  });

                  const probeMsg = probeResult.choices[0]?.message;
                  const toolCalls = (probeMsg?.tool_calls ?? []) as { function: { name: string; arguments: string } }[];
                  hasToolCalls = toolCalls.length > 0;
                  probeData = probeMsg ? [probeMsg] : [];
                  probeInputTokens = probeResult.usage.prompt_tokens;
                  probeOutputTokens = probeResult.usage.completion_tokens;

                  log.withFields({
                    chatId,
                    hasToolCalls,
                    toolCalls: toolCalls.map(tc => ({ name: tc.function.name, args: tc.function.arguments })),
                    content: probeMsg?.content ?? null,
                    usage: probeResult.usage,
                  }).log('Probe result');
                }

                deps.persistProbeResponse(chatId, {
                  requestedAtMs: probeRequestedAt,
                  provider: probeApiFormat,
                  data: probeData,
                  inputTokens: probeInputTokens,
                  outputTokens: probeOutputTokens,
                  reasoningSignatureCompat: config.probe.model.reasoningSignatureCompat ?? '',
                  isActivated: hasToolCalls,
                });

                // Advance processed marker — probe has evaluated these events.
                lastProcessedMs(probeRequestedAt);

                if (!hasToolCalls) {
                  log.withFields({ chatId }).log('Probe: model chose silence');
                  return;
                }

                log.withFields({ chatId }).log('Probe: tool calls detected, activating primary model');
              }
            }

            if (config.primaryModel.maxImagesAllowed != null)
              trimImages(ctx.messages, config.primaryModel.maxImagesAllowed);

            const primaryLateBinding = await renderLateBindingPrompt({
              isProbeEnabled: config.probe.enabled, isProbing: false, isMentioned, isReplied,
            });
            injectLateBindingPrompt(ctx.messages, primaryLateBinding);

            await runner.runStepLoop({
              chatId,
              messages: ctx.messages,
              system,
              tools: [sendMessageTool],
              maxSteps: MAX_STEPS,
              onStepComplete: (stepData, usage, requestedAtMs) => {
                deps.persistTurnResponse(chatId, {
                  requestedAtMs,
                  provider: primaryApiFormat,
                  data: stepData,
                  inputTokens: usage.prompt_tokens,
                  outputTokens: usage.completion_tokens,
                  reasoningSignatureCompat: config.primaryModel.reasoningSignatureCompat ?? '',
                });
                lastProcessedMs(requestedAtMs);
              },
              checkInterrupt: () => {
                if (rc() === rcAtStart) return false;
                return latestExternalEventMs(rc(), lastProcessedMs()) != null;
              },
              log,
            });
          } catch (err) {
            log.withError(err).error('LLM call failed');
            failedRc(rcAtStart);
          } finally {
            running(false);
          }
        })();
      }, 0);
    });

    // --- Independent compaction effect ---
    let compactionRunning = false;
    let compactionTimer: ReturnType<typeof setTimeout> | undefined;
    let lastCheckedRc: RenderedContext | null = null;

    const disposeCompactionEffect = effect(() => {
      if (!config.compaction.enabled) return;
      const rcVal = rc();
      if (rcVal.length === 0) return;

      if (compactionTimer) { clearTimeout(compactionTimer); compactionTimer = undefined; }
      if (compactionRunning) return;
      if (rcVal === lastCheckedRc) return;

      compactionTimer = setTimeout(() => {
        lastCheckedRc = rc();
        compactionRunning = true;

        void (async () => {
          try {
            const cursor = cursorMs();
            const sum = summary();
            const compactEndpoint = config.compaction.model ?? config.primaryModel;

            const trs = loadTRs(chatId, cursor);
            // Estimate tokens WITHOUT summary — summary should not count toward
            // the working window budget, otherwise it grows until it fills the
            // budget and compaction degrades into a sliding window.
            const ctx = composeContext(rc(), trs, config.compaction.maxContextEstTokens, compactEndpoint.reasoningSignatureCompat, config.featureFlags);
            if (!ctx) return;
            // Trigger at maxContextEstTokens (high water mark), compact down to
            // workingWindowEstTokens (low water mark). This gives a wide gap
            // before the next compaction fires.
            if (ctx.rawEstimatedTokens <= config.compaction.maxContextEstTokens) return;

            const newCursorMs = findWorkingWindowCursor(rc(), trs, config.compaction.workingWindowEstTokens);

            log.withFields({
              chatId,
              oldCursorMs: cursor ?? 0,
              newCursorMs,
              rawEstimatedTokens: ctx.rawEstimatedTokens,
              triggerAt: config.compaction.maxContextEstTokens,
              retainBudget: config.compaction.workingWindowEstTokens,
              dryRun: !!config.compaction.dryRun,
            }).log('Triggering compaction');

            const newMeta = await runCompaction({
              apiBaseUrl: compactEndpoint.apiBaseUrl,
              apiKey: compactEndpoint.apiKey,
              model: compactEndpoint.model,
              apiFormat: compactEndpoint.apiFormat,
              chatId,
              rcWindow: rc().filter(s => s.receivedAtMs >= (cursor ?? 0) && s.receivedAtMs < newCursorMs),
              trsWindow: trs.filter(t => t.requestedAtMs >= (cursor ?? 0) && t.requestedAtMs < newCursorMs),
              existingSummary: sum,
              oldCursorMs: cursor ?? 0,
              newCursorMs,
              reasoningSignatureCompat: compactEndpoint.reasoningSignatureCompat,
              featureFlags: config.featureFlags,
              log,
            });

            if (config.compaction.dryRun) {
              log.withFields({
                chatId,
                newCursorMs,
                summaryLength: newMeta.summary.length,
              }).log(`Compaction dry-run complete. Summary:\n${newMeta.summary}`);
            } else {
              // Persist to dedicated compactions table
              deps.persistCompaction(chatId, newMeta);

              log.withFields({
                chatId,
                newCursorMs,
                summaryLength: newMeta.summary.length,
              }).log('Compaction complete');

              // Update signal — cursor effect auto-applies to pipeline + rc
              compactionMeta(newMeta);
            }
          } catch (err) {
            log.withError(err).error('Compaction failed');
          } finally {
            compactionRunning = false;
          }
        })();
      }, 0);
    });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (compactionTimer) clearTimeout(compactionTimer);
      disposeCursorEffect();
      disposeReplyEffect();
      disposeCompactionEffect();
    };

    const entry = { rc, cleanup };
    chatScopes.set(chatId, entry);
    return entry;
  };

  const handleEvent = (chatId: string, newRC: RenderedContext) => {
    if (!chatIds.has(chatId)) return;
    getOrCreateScope(chatId).rc(newRC);
  };

  const stop = () => {
    for (const scope of chatScopes.values())
      scope.cleanup();
    chatScopes.clear();
  };

  return { handleEvent, stop };
};
