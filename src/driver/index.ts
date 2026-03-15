import type { Logger } from '@guiiai/logg';
import { computed, effect, signal } from 'alien-signals';

import { runCompaction } from './compaction';
import { composeContext, findWorkingWindowCursor, latestExternalEventMs } from './context';
import { renderSystemPrompt } from './prompt';
import { createRunner } from './runner';
import { createSendMessageTool } from './tools';
import type { CompactionSessionMeta, DriverConfig, TurnResponse } from './types';
import type { RenderedContext } from '../rendering/types';

export { mergeContext } from './merge';
export { renderSystemPrompt } from './prompt';
export type { DriverConfig, TurnResponse } from './types';

const DEBOUNCE_MS = 2000;
const MAX_STEPS = 5;

export const createDriver = (config: DriverConfig, deps: {
  loadTurnResponses: (chatId: string, afterMs?: number) => TurnResponse[];
  persistTurnResponse: (chatId: string, tr: TurnResponse) => void;
  sendMessage: (chatId: string, text: string, replyToMessageId?: number) => Promise<{ messageId: number; date: number }>;
  loadCompaction: (chatId: string) => CompactionSessionMeta | null;
  persistCompaction: (chatId: string, meta: CompactionSessionMeta) => void;
  setCompactCursor: (chatId: string, cursorMs: number) => RenderedContext | undefined;
  logger: Logger;
}) => {
  const { logger } = deps;
  const log = logger.withContext('driver');
  const chatIds = new Set(config.chatIds);

  const runner = createRunner({
    apiBaseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    model: config.model,
  });

  const loadTRs = (chatId: string, afterMs?: number): TurnResponse[] =>
    deps.loadTurnResponses(chatId, afterMs);

  const getLastTrTime = (chatId: string): number => {
    const trs = deps.loadTurnResponses(chatId);
    if (trs.length === 0) return 0;
    return trs[trs.length - 1]!.requestedAtMs;
  };

  const chatScopes = new Map<string, {
    rc: ReturnType<typeof signal<RenderedContext>>;
    cleanup: () => void;
  }>();

  const getOrCreateScope = (chatId: string) => {
    const existing = chatScopes.get(chatId);
    if (existing) return existing;

    const rc = signal<RenderedContext>([]);
    const lastTrTimeMs = signal(getLastTrTime(chatId));
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
    const deadline = computed(() => {
      const rcVal = rc();
      if (rcVal.length === 0) return null;
      if (rcVal === failedRc()) return null;
      const latestMs = latestExternalEventMs(rcVal, lastTrTimeMs());
      if (latestMs == null) return null;
      return latestMs + DEBOUNCE_MS;
    });

    const disposeReplyEffect = effect(() => {
      const isRunning = running();
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (isRunning) return;

      const d = deadline();
      if (d == null) return;

      const remaining = Math.max(0, d - Date.now());
      timer = setTimeout(() => {
        const rcAtStart = rc();
        running(true);

        void (async () => {
          try {
            // Read compaction state from signal — no DB query.
            const cursor = cursorMs();
            const sum = summary();

            const trs = loadTRs(chatId, cursor);
            const ctx = composeContext(rc(), trs, config.compaction.maxContextEstTokens, config.reasoningSignatureCompat, config.featureFlags, sum);
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

            await runner.runStepLoop({
              chatId,
              messages: ctx.messages,
              system,
              tools: [sendMessageTool],
              maxSteps: MAX_STEPS,
              onStepComplete: (stepData, usage, requestedAtMs) => {
                deps.persistTurnResponse(chatId, {
                  requestedAtMs,
                  provider: 'openai-chat',
                  data: stepData,
                  inputTokens: usage.prompt_tokens,
                  outputTokens: usage.completion_tokens,
                  reasoningSignatureCompat: config.reasoningSignatureCompat ?? '',
                });
                lastTrTimeMs(requestedAtMs);
              },
              checkInterrupt: () => {
                if (rc() === rcAtStart) return false;
                return latestExternalEventMs(rc(), lastTrTimeMs()) != null;
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
      }, remaining);
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
            const trs = loadTRs(chatId, cursor);
            // Estimate tokens WITHOUT summary — summary should not count toward
            // the working window budget, otherwise it grows until it fills the
            // budget and compaction degrades into a sliding window.
            const ctx = composeContext(rc(), trs, config.compaction.maxContextEstTokens, config.reasoningSignatureCompat, config.featureFlags);
            if (!ctx) return;
            // Trigger at maxContextEstTokens (high water mark), compact down to
            // workingWindowEstTokens (low water mark). This gives a wide gap
            // before the next compaction fires.
            if (ctx.estimatedTokens <= config.compaction.maxContextEstTokens) return;

            const newCursorMs = findWorkingWindowCursor(rc(), trs, config.compaction.workingWindowEstTokens);

            log.withFields({
              chatId,
              oldCursorMs: cursor ?? 0,
              newCursorMs,
              estimatedTokens: ctx.estimatedTokens,
              triggerAt: config.compaction.maxContextEstTokens,
              retainBudget: config.compaction.workingWindowEstTokens,
              dryRun: !!config.compaction.dryRun,
            }).log('Triggering compaction');

            const compactModel = config.compaction.compactModel ?? config.model;
            const newMeta = await runCompaction({
              apiBaseUrl: config.apiBaseUrl,
              apiKey: config.apiKey,
              model: compactModel,
              chatId,
              rcWindow: rc().filter(s => s.receivedAtMs >= (cursor ?? 0) && s.receivedAtMs < newCursorMs),
              trsWindow: trs.filter(t => t.requestedAtMs >= (cursor ?? 0) && t.requestedAtMs < newCursorMs),
              existingSummary: sum,
              oldCursorMs: cursor ?? 0,
              newCursorMs,
              reasoningSignatureCompat: config.reasoningSignatureCompat,
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
