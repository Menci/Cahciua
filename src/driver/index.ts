import type { Logger } from '@guiiai/logg';
import { computed, effect, signal } from 'alien-signals';

import { callLlm, type ToolSchema } from './call-llm';
import { runCompaction } from './compaction';
import { composeContext, findWorkingWindowCursor, injectLateBindingPrompt, latestExternalEventMs, triggerSenderLatestMs, wasToolLoopInterrupted } from './context';
import { renderLateBindingPrompt, renderSystemPrompt } from './prompt';
import { createRunner } from './runner';
import { createBashTool, createAttachmentDownloader, createDismissMessageTool, createDownloadFileTool, createKillTaskTool, createReadImageTool, createReadTaskOutputTool, createSendMessageTool, createSleepTool, createWebFetchTool, createWebSearchTool } from './tools';
import type { CahciuaTool, SendMessageAttachment } from './tools';
import type { CompactionSessionMeta, DriverConfig, LlmEndpoint, ProbeResponseV2, TurnResponseV2 } from './types';
import { createWebFetcher } from './web-fetch';
import type { ActiveTaskInfo } from '../background-task/types';
import type { RuntimeConfig } from '../config/config';
import type { RenderedContext } from '../rendering/types';
import { renderImageToTextSystemPrompt } from '../telegram/image-to-text-prompt';
import { callDescriptionLlm } from '../telegram/llm-description';
import type { Attachment } from '../telegram/message/types';

/** Format current time in local timezone as ISO 8601 with offset (e.g. 2025-03-13T22:30:00+08:00). */
const localTimeNow = (): string => {
  const now = new Date();
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const tz = `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  const iso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  return `${iso}${tz}`;
};

export { mergeContext } from './merge';
export { renderLateBindingPrompt, renderSystemPrompt } from './prompt';
export type { DriverConfig, ProviderFormat } from './types';
export type { TurnResponseV2, ProbeResponseV2 } from './types';

const MAX_STEPS = Infinity;

const toToolSchema = (t: CahciuaTool): ToolSchema => ({
  name: t.function.name,
  parameters: t.function.parameters,
  ...(t.function.description ? { description: t.function.description } : {}),
});

export const createDriver = (config: DriverConfig, deps: {
  loadTurnResponses: (chatId: string, afterMs?: number) => Promise<TurnResponseV2[]>;
  persistTurnResponse: (chatId: string, tr: TurnResponseV2) => Promise<void>;
  persistProbeResponse: (chatId: string, probe: ProbeResponseV2) => Promise<void>;
  sendMessage: (chatId: string, text: string, replyToMessageId?: number, attachments?: SendMessageAttachment[]) => Promise<{ messageId: number; date: number }>;
  sendTypingAction?: (chatId: string) => Promise<void>;
  // Called when a chat enters (true) / leaves (false) its debounce window, so the
  // host can run an active typing poll for large supergroups only while waiting.
  onDebounceStateChange?: (chatId: string, isDebouncing: boolean) => void;
  loadCompaction: (chatId: string) => CompactionSessionMeta | null;
  loadLastProbeTime: (chatId: string) => number;
  persistCompaction: (chatId: string, meta: CompactionSessionMeta) => void;
  setCompactCursor: (chatId: string, cursorMs: number) => RenderedContext | undefined;
  getChatTitle: (chatId: string) => string | undefined;
  runtimeConfig: RuntimeConfig;
  loadMessageAttachments: (chatId: string, messageId: number) => Attachment[] | undefined;
  downloadFile: (fileId: string) => Promise<Buffer>;
  downloadMessageMedia?: (chatId: string, messageId: number) => Promise<Buffer | undefined>;
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

  // Runner cache: keyed by "apiBaseUrl::model" to reuse runners across chats
  // sharing the same endpoint.
  const runners = new Map<string, ReturnType<typeof createRunner>>();
  const getOrCreateRunner = (endpoint: LlmEndpoint) => {
    const key = `${endpoint.apiBaseUrl}::${endpoint.model}`;
    let runner = runners.get(key);
    if (!runner) {
      runner = createRunner({
        apiBaseUrl: endpoint.apiBaseUrl,
        apiKey: endpoint.apiKey,
        model: endpoint.model,
        apiFormat: endpoint.apiFormat ?? 'openai-chat',
        timeoutSec: endpoint.timeoutSec,
        thinking: endpoint.thinking,
        forceToolCall: endpoint.forceToolCall,
      });
      runners.set(key, runner);
    }
    return runner;
  };

  const loadTRs = (chatId: string, afterMs?: number): Promise<TurnResponseV2[]> =>
    deps.loadTurnResponses(chatId, afterMs);

  const getLastProcessedTime = async (chatId: string): Promise<number> => {
    const trs = await deps.loadTurnResponses(chatId);
    const lastTr = trs.length > 0 ? trs[trs.length - 1]!.requestedAtMs : 0;
    const lastProbe = deps.loadLastProbeTime(chatId);
    return Math.max(lastTr, lastProbe);
  };

  const chatScopes = new Map<string, {
    rc: ReturnType<typeof signal<RenderedContext>>;
    lastTypingMs: ReturnType<typeof signal<number>>;
    cleanup: () => void;
  }>();

  const getOrCreateScope = (chatId: string) => {
    const existing = chatScopes.get(chatId);
    if (existing) return existing;

    // Resolve per-chat config once per scope
    const chatConfig = config.resolveChatConfig(chatId);

    const rc = signal<RenderedContext>([]);
    const lastProcessedMs = signal(0);
    void getLastProcessedTime(chatId).then(v => lastProcessedMs(Math.max(lastProcessedMs(), v)));
    const running = signal(false);
    const failedRc = signal<RenderedContext | null>(null);
    // Typing signal: written by handleTyping when another user is typing. The reply
    // effect reads it declaratively to extend the debounce window.
    const lastTypingMs = signal(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Start of the current debounce window — caps total wait at maxDelayMs.
    let debounceWindowStartMs: number | undefined;
    // Whether we're currently in a debounce window — drives the typing-poll
    // lifecycle. Notify the host only on transitions.
    let isDebouncing = false;
    const setDebouncing = (v: boolean) => {
      if (isDebouncing === v) return;
      isDebouncing = v;
      deps.onDebounceStateChange?.(chatId, v);
    };

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
    // Typing-aware debounce: after new external messages arrive, wait
    // `initialDelayMs` past the latest message from the *trigger sender* (the one
    // whose message opened the window) before replying, so a burst from that
    // person is answered once. Only the trigger sender's further messages extend
    // the wait; other people talking does not. Anyone typing extends the wait by
    // `typingExtendMs`; total wait is capped at `maxDelayMs` from when the window
    // opened. Everything is signal-driven — new messages (rc) and typing
    // (lastTypingMs) re-run the effect, which recomputes the deadline. The
    // `running` signal still serializes calls, so messages arriving mid-call
    // accumulate and are picked up on the next window.
    const { initialDelayMs, typingExtendMs, maxDelayMs } = chatConfig.debounce;

    const needsReply = computed(() => {
      const rcVal = rc();
      if (rcVal.length === 0) return false;
      if (rcVal === failedRc()) return false;
      return latestExternalEventMs(rcVal, lastProcessedMs()) != null;
    });

    const disposeReplyEffect = effect(() => {
      const isRunning = running();
      const typingAt = lastTypingMs();
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (isRunning || !needsReply()) { debounceWindowStartMs = undefined; setDebouncing(false); return; }

      const now = Date.now();
      debounceWindowStartMs ??= now;
      setDebouncing(true);

      const lastMsgMs = triggerSenderLatestMs(rc(), lastProcessedMs()) ?? now;
      let fireAtMs = lastMsgMs + initialDelayMs;
      if (typingAt > 0) fireAtMs = Math.max(fireAtMs, typingAt + typingExtendMs);
      fireAtMs = Math.min(fireAtMs, debounceWindowStartMs + maxDelayMs);

      timer = setTimeout(() => {
        timer = undefined;
        debounceWindowStartMs = undefined;
        setDebouncing(false);
        const rcAtStart = rc();
        running(true);

        void (async () => {
          try {
            // Read compaction state from signal — no DB query.
            const cursor = cursorMs();
            const sum = summary();

            const trs = await loadTRs(chatId, cursor);
            const ctx = composeContext(rcAtStart, trs, chatConfig.compaction.maxContextEstTokens, chatConfig.primaryModel.model, sum);
            if (!ctx) return;

            log.withFields({
              chatId,
              entries: ctx.entries.length,
              estimatedTokens: ctx.estimatedTokens,
            }).log('Triggering LLM call');

            const sendMessageTool = createSendMessageTool(async (text, replyTo, attachments) => {
              log.withFields({
                chatId,
                text: text.length > 100 ? `${text.slice(0, 100)}...` : text,
                replyTo,
                attachments: attachments?.length ?? 0,
              }).log('send_message tool called');
              const sent = await deps.sendMessage(chatId, text, replyTo ? Number(replyTo) : undefined, attachments);
              return { messageId: String(sent.messageId) };
            });

            const downloadAttachment = createAttachmentDownloader({
              chatId,
              loadMessageAttachments: deps.loadMessageAttachments,
              downloadFile: deps.downloadFile,
              downloadMessageMedia: deps.downloadMessageMedia,
            });

            const tools: CahciuaTool[] = [sendMessageTool, createDismissMessageTool()];
            tools.push(createBashTool(deps.runtimeConfig, {
              startTask: deps.backgroundTask.startTask,
              sessionId: chatId,
              backgroundThresholdSec: chatConfig.tools.bash.backgroundThresholdSec,
            }));
            tools.push(createWebSearchTool(chatConfig.tools.webSearch.tavilyKey));
            if (chatConfig.tools.webFetch)
              tools.push(createWebFetchTool(createWebFetcher(chatConfig.tools.webFetch)));
            tools.push(createDownloadFileTool({
              downloadAttachment,
              runtime: deps.runtimeConfig,
            }));
            {
              const readFileCmd = deps.runtimeConfig.readFile;
              const resolveImageToText = chatConfig.imageToText.enabled && chatConfig.imageToText.model
                ? async (buffer: Buffer, detail: 'low' | 'high') => {
                  const maxEdge = detail === 'high' ? 1024 : 512;
                  const { default: sharp } = await import('sharp');
                  const resized = await sharp(buffer)
                    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
                    .png()
                    .toBuffer();
                  const imageUrl = `data:image/png;base64,${resized.toString('base64')}`;
                  const system = await renderImageToTextSystemPrompt({ caption: '', detail });
                  const model = deps.resolveModel(chatConfig.imageToText.model!);
                  const result = await callDescriptionLlm({
                    model, system,
                    userText: 'Describe this image.',
                    images: [{ url: imageUrl }],
                    log, label: 'read-image',
                  });
                  return result.text.trim();
                }
                : undefined;

              tools.push(createReadImageTool({
                downloadAttachment,
                readFile: async path => {
                  const { execFile } = await import('node:child_process');
                  return await new Promise<Buffer>((resolve, reject) => {
                    const child = execFile(
                      readFileCmd[0]!,
                      [...readFileCmd.slice(1), path],
                      { timeout: 60_000, maxBuffer: deps.runtimeConfig.readFileSizeLimit, encoding: 'buffer' as any },
                      (error, stdout) => {
                        if (error) reject(new Error(`Failed to read file: ${error.message}`));
                        else resolve(stdout as unknown as Buffer);
                      },
                    );
                    child.stdin?.end();
                  });
                },
                resolveImageToText,
              }));
            }
            tools.push(createKillTaskTool(taskId => deps.backgroundTask.killTask(taskId)));
            tools.push(createReadTaskOutputTool((taskId, offset, limit) => deps.backgroundTask.readTaskOutput(taskId, offset, limit)));
            tools.push(createSleepTool());

            const system = await renderSystemPrompt({
              currentChannel: 'telegram',
              modelName: chatConfig.primaryModel.model,
              chatId,
              chatTitle: deps.getChatTitle(chatId),
              systemFiles: chatConfig.systemFiles,
              forceToolCall: chatConfig.primaryModel.forceToolCall,
            });

            // --- Compute mention/reply/interrupt state from RC + TRs ---
            const rcVal = rcAtStart;
            const isInterrupted = wasToolLoopInterrupted(trs);
            const lastMentionedAtMs = rcVal.reduce((max, seg) =>
              (seg.mentionsMe || seg.repliesToMe || seg.isRuntimeEvent) ? Math.max(max, seg.receivedAtMs) : max, 0);
            const isMentioned = rcVal.some(seg => seg.mentionsMe && seg.receivedAtMs > lastProcessedMs());
            const isReplied = rcVal.some(seg => seg.repliesToMe && seg.receivedAtMs > lastProcessedMs());

            const lateBindingParams = {
              timeNow: localTimeNow(),
              isMentioned, isReplied,
              isInterrupted,
              forceToolCall: chatConfig.primaryModel.forceToolCall,
              activeBackgroundTasks: deps.backgroundTask.getActiveTasks(chatId),
            };

            // --- Probe gate ---
            // Skip probe if: mentioned, replied to, runtime event, or tool loop was interrupted.
            // In those cases go straight to primary model.
            if (chatConfig.probe.enabled && !isInterrupted) {
              const needsProbe = lastMentionedAtMs <= lastProcessedMs();

              if (needsProbe) {
                log.withFields({ chatId, lastMentionedAtMs, lastProcessedMs: lastProcessedMs() }).log('Running probe');

                const probeEntries = [...ctx.entries];
                injectLateBindingPrompt(probeEntries, await renderLateBindingPrompt({
                  ...lateBindingParams, isProbeEnabled: true, isProbing: true,
                }));

                const probeRequestedAt = Date.now();
                const probeResult = await callLlm(
                  chatConfig.probe.model, probeEntries, system,
                  tools.map(toToolSchema),
                  { log, label: `probe:${chatId}`, maxImagesAllowed: chatConfig.probe.model.maxImagesAllowed },
                );

                const hasToolCalls = probeResult.entries.some(
                  e => e.kind === 'message' && e.role === 'assistant'
                    && e.parts.some(p => p.kind === 'toolCall' && p.name !== 'dismiss_message'),
                );

                log.withFields({ chatId, hasToolCalls }).log('Probe result');

                await deps.persistProbeResponse(chatId, {
                  requestedAtMs: probeRequestedAt,
                  entries: probeResult.entries,
                  inputTokens: probeResult.usage.inputTokens,
                  outputTokens: probeResult.usage.outputTokens,
                  cacheReadTokens: probeResult.usage.cacheReadTokens,
                  cacheWriteTokens: probeResult.usage.cacheWriteTokens,
                  modelName: chatConfig.probe.model.model,
                  isActivated: hasToolCalls,
                  createdAt: Date.now(),
                });

                lastProcessedMs(probeRequestedAt);

                if (!hasToolCalls) {
                  log.withFields({ chatId }).log('Probe: model chose silence');
                  return;
                }
                log.withFields({ chatId }).log('Probe: tool calls detected, activating primary model');
              }
            }

            injectLateBindingPrompt(ctx.entries, await renderLateBindingPrompt({
              ...lateBindingParams, isProbeEnabled: chatConfig.probe.enabled, isProbing: false,
            }));

            const runner = getOrCreateRunner(chatConfig.primaryModel);

            // Show a "typing…" action while the model works, refreshed every 5s
            // (Telegram clears it after ~5s). Best-effort — failures are ignored.
            let typingInterval: ReturnType<typeof setInterval> | undefined;
            if (deps.sendTypingAction && chatConfig.sendTypingAction) {
              void deps.sendTypingAction(chatId).catch(() => {});
              typingInterval = setInterval(() => {
                void deps.sendTypingAction!(chatId).catch(() => {});
              }, 5000);
            }

            try {
              await runner.runStepLoop({
                chatId,
                entries: ctx.entries,
                system,
                tools,
                maxSteps: MAX_STEPS,
                maxImagesAllowed: chatConfig.primaryModel.maxImagesAllowed,
                onStepComplete: async (stepEntries, usage, requestedAtMs) => {
                  await deps.persistTurnResponse(chatId, {
                    requestedAtMs,
                    entries: stepEntries,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cacheReadTokens: usage.cacheReadTokens,
                    cacheWriteTokens: usage.cacheWriteTokens,
                    modelName: chatConfig.primaryModel.model,
                  });
                  lastProcessedMs(requestedAtMs);
                },
                checkInterrupt: () => {
                  if (rc() === rcAtStart) return false;
                  return latestExternalEventMs(rc(), lastProcessedMs()) != null;
                },
                log,
              });
            } finally {
              if (typingInterval) clearInterval(typingInterval);
            }
          } catch (err) {
            // No retry or backoff — a failed call is recorded via failedRc and
            // only re-attempted when new external messages produce a fresh RC.
            log.withError(err).error('LLM call failed');
            failedRc(rcAtStart);
          } finally {
            running(false);
          }
        })();
      }, Math.max(0, fireAtMs - now));
    });

    // --- Independent compaction effect ---
    let compactionRunning = false;
    let compactionTimer: ReturnType<typeof setTimeout> | undefined;
    let lastCheckedRc: RenderedContext | null = null;

    const disposeCompactionEffect = effect(() => {
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
            const compactEndpoint = chatConfig.compaction.model ?? chatConfig.primaryModel;

            const trs = await loadTRs(chatId, cursor);
            const ctx = composeContext(rc(), trs, chatConfig.compaction.maxContextEstTokens, compactEndpoint.model);
            if (!ctx) return;
            if (ctx.rawEstimatedTokens <= chatConfig.compaction.maxContextEstTokens) return;

            const newCursorMs = findWorkingWindowCursor(rc(), trs, chatConfig.compaction.workingWindowEstTokens);

            log.withFields({
              chatId,
              oldCursorMs: cursor ?? 0,
              newCursorMs,
              rawEstimatedTokens: ctx.rawEstimatedTokens,
              triggerAt: chatConfig.compaction.maxContextEstTokens,
              retainBudget: chatConfig.compaction.workingWindowEstTokens,
            }).log('Triggering compaction');

            const newMeta = await runCompaction({
              apiBaseUrl: compactEndpoint.apiBaseUrl,
              apiKey: compactEndpoint.apiKey,
              model: compactEndpoint.model,
              apiFormat: compactEndpoint.apiFormat,
              timeoutSec: compactEndpoint.timeoutSec,
              thinking: compactEndpoint.thinking,
              chatId,
              rcWindow: rc().filter(s => s.receivedAtMs >= (cursor ?? 0) && s.receivedAtMs < newCursorMs),
              trsWindow: trs.filter(t => t.requestedAtMs >= (cursor ?? 0) && t.requestedAtMs < newCursorMs),
              existingSummary: sum,
              oldCursorMs: cursor ?? 0,
              newCursorMs,
              maxImagesAllowed: compactEndpoint.maxImagesAllowed,
              log,
            });

            deps.persistCompaction(chatId, newMeta);

            log.withFields({
              chatId,
              newCursorMs,
              summaryLength: newMeta.summary.length,
            }).log('Compaction complete');

            compactionMeta(newMeta);
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
      setDebouncing(false);
      disposeCursorEffect();
      disposeReplyEffect();
      disposeCompactionEffect();
    };

    const entry = { rc, lastTypingMs, cleanup };
    chatScopes.set(chatId, entry);
    return entry;
  };

  const handleEvent = (chatId: string, newRC: RenderedContext) => {
    if (!chatIds.has(chatId)) return;
    getOrCreateScope(chatId).rc(newRC);
  };

  const handleTyping = (chatId: string) => {
    if (!chatIds.has(chatId)) return;
    getOrCreateScope(chatId).lastTypingMs(Date.now());
  };

  const stop = () => {
    for (const scope of chatScopes.values())
      scope.cleanup();
    chatScopes.clear();
  };

  return { handleEvent, handleTyping, stop };
};
