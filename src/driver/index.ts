import type { Logger } from '@guiiai/logg';
import { signal } from 'alien-signals';

import { createCompactionController } from './compaction-controller';
import { wasToolLoopInterrupted } from './context';
import { createPrimaryTools } from './primary-tools';
import { createRunner } from './runner';
import { createReplyScheduler } from './scheduler';
import type { SendMessageAttachment } from './tools';
import type { CompactionSessionMeta, DriverConfig, ProbeResponseV2, TurnResponseV2 } from './types';
import { executeWakeup } from './wakeup';
import type { ActiveTaskInfo } from '../background-task/types';
import type { RuntimeConfig } from '../config/config';
import type { LlmEndpoint } from '../llm/types';
import type { RenderedContext } from '../rendering/types';
import type { Attachment } from '../telegram/message/types';

export { mergeContext } from './merge';
export { renderLateBindingPrompt, renderSystemPrompt } from './prompt';
export type { DriverConfig } from './types';
export type { TurnResponseV2, ProbeResponseV2 } from './types';

export const createDriver = (config: DriverConfig, deps: {
  loadTurnResponses: (chatId: string, afterMs?: number) => Promise<TurnResponseV2[]>;
  persistTurnResponse: (chatId: string, tr: TurnResponseV2) => Promise<void>;
  persistProbeResponse: (chatId: string, probe: ProbeResponseV2) => Promise<void>;
  sendMessage: (chatId: string, text: string, replyToMessageId?: number, attachments?: SendMessageAttachment[]) => Promise<{ messageId: number; date: number }>;
  setMessageReaction: (chatId: string, messageId: number, emoji: string | undefined) => Promise<void>;
  sendTypingAction: (chatId: string) => Promise<void>;
  // Called when a chat enters (true) / leaves (false) its debounce window, so the
  // host can run an active typing poll for large supergroups only while waiting.
  onDebounceStateChange: (chatId: string, isDebouncing: boolean) => void;
  loadCompaction: (chatId: string) => CompactionSessionMeta | null;
  loadLastProbeTime: (chatId: string) => number;
  persistCompaction: (chatId: string, meta: CompactionSessionMeta) => void;
  setCompactCursor: (chatId: string, cursorMs: number) => RenderedContext;
  getChatTitle: (chatId: string) => string | undefined;
  runtimeConfig: RuntimeConfig;
  loadMessageAttachments: (chatId: string, messageId: number) => Attachment[] | undefined;
  messageExists: (chatId: string, messageId: number) => boolean;
  downloadMessageMedia: (chatId: string, messageId: number) => Promise<Buffer | undefined>;
  resolveModel: (name: string) => LlmEndpoint;
  backgroundTask: {
    startTask: (typeName: string, sessionId: string, params: unknown, intention: string | undefined, timeoutMs: number) => number;
    killTask: (taskId: number) => { ok: boolean; error?: string };
    getActiveTasks: (sessionId: string) => ActiveTaskInfo[];
    readTaskOutput: (taskId: number, offset?: number, limit?: number) => Promise<{ content: string; totalLines: number; truncated: boolean } | { error: string }>;
  };
  logger: Logger;
}) => {
  const { logger } = deps;
  const log = logger.withContext('driver');
  const chatIds = new Set(config.chatIds);

  const getLastProcessedTime = async (chatId: string): Promise<number> => {
    const trs = await deps.loadTurnResponses(chatId);
    const lastTr = trs.length > 0 ? trs[trs.length - 1]!.requestedAtMs : 0;
    const lastProbe = deps.loadLastProbeTime(chatId);
    return Math.max(lastTr, lastProbe);
  };

  const chatScopes = new Map<string, {
    rc: ReturnType<typeof signal<RenderedContext>>;
    notifyTyping: () => void;
    cleanup: () => void;
  }>();

  const getOrCreateScope = (chatId: string) => {
    const existing = chatScopes.get(chatId);
    if (existing) return existing;

    const chatConfig = config.resolveChatConfig(chatId);

    const rc = signal<RenderedContext>([]);
    const lastProcessedMs = signal(0);
    // A persisted requiresFollowUp result keeps the wake-up eligible after restart.
    const lastTRInterrupted = signal(false);
    void getLastProcessedTime(chatId).then(v => lastProcessedMs(Math.max(lastProcessedMs(), v)));
    void deps.loadTurnResponses(chatId).then(trs => lastTRInterrupted(wasToolLoopInterrupted(trs)));
    const failedRc = signal<RenderedContext | null>(null);

    const compactionMeta = signal<CompactionSessionMeta | null>(
      deps.loadCompaction(chatId),
    );

    const compaction = createCompactionController({
      chatId,
      chatConfig,
      context: rc,
      compactionMeta,
      loadTurnResponses: deps.loadTurnResponses,
      persistCompaction: deps.persistCompaction,
      setCompactCursor: deps.setCompactCursor,
      log,
    });
    const { cursorMs, summary } = compaction;
    const runner = createRunner({
      apiBaseUrl: chatConfig.primary.model.apiBaseUrl,
      apiKey: chatConfig.primary.model.apiKey,
      model: chatConfig.primary.model.model,
      apiFormat: chatConfig.primary.model.apiFormat,
      timeoutSec: chatConfig.primary.model.timeoutSec,
      extraBody: chatConfig.primary.model.extraBody,
    });

    const createTools = () => createPrimaryTools({
      chatId,
      chatConfig,
      runtimeConfig: deps.runtimeConfig,
      sendMessage: deps.sendMessage,
      setMessageReaction: deps.setMessageReaction,
      loadMessageAttachments: deps.loadMessageAttachments,
      messageExists: deps.messageExists,
      downloadMessageMedia: deps.downloadMessageMedia,
      resolveModel: deps.resolveModel,
      backgroundTask: deps.backgroundTask,
      log,
    });

    const scheduler = createReplyScheduler({
      chatId,
      debounce: chatConfig.debounce,
      context: rc,
      lastProcessedMs,
      lastTurnInterrupted: lastTRInterrupted,
      failedContext: failedRc,
      onDebounceStateChange: deps.onDebounceStateChange,
      execute: async contextAtStart => {
        try {
          await executeWakeup({
            chatId,
            chatConfig,
            contextAtStart,
            currentContext: rc,
            cursorMs: cursorMs(),
            summary: summary(),
            loadTurnResponses: deps.loadTurnResponses,
            persistTurnResponse: deps.persistTurnResponse,
            persistProbeResponse: deps.persistProbeResponse,
            getChatTitle: deps.getChatTitle,
            getActiveBackgroundTasks: deps.backgroundTask.getActiveTasks,
            sendTypingAction: deps.sendTypingAction,
            createTools,
            runner,
            getLastProcessedMs: lastProcessedMs,
            setLastProcessedMs: lastProcessedMs,
            log,
          });
        } catch (error) {
          log.withError(error).withFields({ chatId }).error('LLM call failed');
          failedRc(contextAtStart);
        } finally {
          try {
            const responses = await deps.loadTurnResponses(chatId, cursorMs());
            lastTRInterrupted(wasToolLoopInterrupted(responses));
          } catch (error) {
            log.withError(error).withFields({ chatId }).warn('Failed to refresh lastTRInterrupted');
          }
        }
      },
    });

    const cleanup = () => {
      scheduler.dispose();
      compaction.dispose();
    };

    const entry = { rc, notifyTyping: scheduler.notifyTyping, cleanup };
    chatScopes.set(chatId, entry);
    return entry;
  };

  const handleEvent = (chatId: string, newRC: RenderedContext) => {
    if (!chatIds.has(chatId)) return;
    getOrCreateScope(chatId).rc(newRC);
  };

  const handleTyping = (chatId: string) => {
    if (!chatIds.has(chatId)) return;
    getOrCreateScope(chatId).notifyTyping();
  };

  const stop = () => {
    for (const scope of chatScopes.values())
      scope.cleanup();
    chatScopes.clear();
  };

  return { handleEvent, handleTyping, stop };
};
