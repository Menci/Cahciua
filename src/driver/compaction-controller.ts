import type { Logger } from '@guiiai/logg';
import { computed, effect } from 'alien-signals';

import { runCompaction } from './compaction';
import { composeContext, findWorkingWindowCursor } from './context';
import type { CompactionSessionMeta, ResolvedChatConfig, TurnResponseV2 } from './types';
import type { RenderedContext } from '../rendering/types';

type Signal<T> = {
  (): T;
  (value: T): void;
};

export const createCompactionController = (deps: {
  chatId: string;
  chatConfig: ResolvedChatConfig;
  context: Signal<RenderedContext>;
  compactionMeta: Signal<CompactionSessionMeta | null>;
  loadTurnResponses: (chatId: string, afterMs?: number) => Promise<TurnResponseV2[]>;
  persistCompaction: (chatId: string, meta: CompactionSessionMeta) => void;
  setCompactCursor: (chatId: string, cursorMs: number) => RenderedContext;
  log: Logger;
}) => {
  const cursorMs = computed(() => deps.compactionMeta()?.newCursorMs);
  const summary = computed(() => deps.compactionMeta()?.summary);

  const disposeCursorEffect = effect(() => {
    const cursor = cursorMs();
    if (cursor == null) return;
    deps.context(deps.setCompactCursor(deps.chatId, cursor));
  });

  let running = false;
  let pendingRecheck = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCheckedContext: RenderedContext | null = null;

  const scheduleCheck = (): void => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      lastCheckedContext = deps.context();
      running = true;
      void (async () => {
        try {
          const cursor = cursorMs();
          const oldCursorMs = cursor ?? 0;
          const compactEndpoint = deps.chatConfig.compaction.model ?? deps.chatConfig.primary.model;
          const turnResponses = await deps.loadTurnResponses(deps.chatId, cursor);
          const composed = composeContext(
            deps.context(),
            turnResponses,
            deps.chatConfig.compaction.maxContextEstTokens,
            compactEndpoint.model,
          );
          if (!composed || composed.rawEstimatedTokens <= deps.chatConfig.compaction.maxContextEstTokens) return;

          const newCursorMs = findWorkingWindowCursor(
            deps.context(),
            turnResponses,
            deps.chatConfig.compaction.workingWindowEstTokens,
          );
          deps.log.withFields({
            chatId: deps.chatId,
            oldCursorMs,
            newCursorMs,
            rawEstimatedTokens: composed.rawEstimatedTokens,
            triggerAt: deps.chatConfig.compaction.maxContextEstTokens,
            retainBudget: deps.chatConfig.compaction.workingWindowEstTokens,
          }).log('Triggering compaction');

          const meta = await runCompaction({
            apiBaseUrl: compactEndpoint.apiBaseUrl,
            apiKey: compactEndpoint.apiKey,
            model: compactEndpoint.model,
            apiFormat: compactEndpoint.apiFormat,
            timeoutSec: compactEndpoint.timeoutSec,
            extraBody: compactEndpoint.extraBody,
            chatId: deps.chatId,
            rcWindow: deps.context().filter(segment =>
              segment.receivedAtMs >= oldCursorMs && segment.receivedAtMs < newCursorMs),
            trsWindow: turnResponses.filter(response =>
              response.requestedAtMs >= oldCursorMs && response.requestedAtMs < newCursorMs),
            existingSummary: summary(),
            oldCursorMs,
            newCursorMs,
            maxImagesAllowed: compactEndpoint.maxImagesAllowed,
            log: deps.log,
          });
          deps.persistCompaction(deps.chatId, meta);
          deps.log.withFields({
            chatId: deps.chatId,
            newCursorMs,
            summaryLength: meta.summary.length,
          }).log('Compaction complete');
          deps.compactionMeta(meta);
        } catch (error) {
          deps.log.withError(error).withFields({ chatId: deps.chatId }).error('Compaction failed');
        } finally {
          running = false;
          if (!disposed && pendingRecheck) {
            pendingRecheck = false;
            scheduleCheck();
          }
        }
      })();
    }, 0);
  };

  const disposeCompactionEffect = effect(() => {
    const context = deps.context();
    if (context.length === 0 || context === lastCheckedContext) return;
    if (running) {
      pendingRecheck = true;
      return;
    }
    scheduleCheck();
  });

  return {
    cursorMs,
    summary,
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      disposeCursorEffect();
      disposeCompactionEffect();
    },
  };
};
