import type { Logger } from '@guiiai/logg';
import { computed, effect, signal } from 'alien-signals';

import { callLlm, type ToolSchema } from './call-llm';
import { runCompaction } from './compaction';
import { composeContext, composeProbeContext, findWorkingWindowCursor, injectLateBindingPrompt, latestExternalEventMs, loopEndedWithoutSendMessage, triggerSenderLatestMs, wasToolLoopInterrupted } from './context';
import { renderLateBindingPrompt, renderSystemPrompt } from './prompt';
import { createRunner } from './runner';
import { createBashTool, createAttachmentDownloader, createDecideTool, createDownloadFileTool, createEndTurnTool, createKillTaskTool, createReactTool, createReadImageTool, createReadTaskOutputTool, createSendMessageTool, createSleepTool, createWebFetchTool, createWebSearchTool, extractDecideResult } from './tools';
import type { CahciuaTool, SendMessageAttachment } from './tools';
import type { CompactionSessionMeta, DriverConfig, LlmEndpoint, ProbeResponseV2, TurnResponseV2 } from './types';
import { createWebFetcher } from './web-fetch';
import { createWebSearcher } from './web-search';
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
  setMessageReaction: (chatId: string, messageId: number, emoji: string | undefined) => Promise<void>;
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
    // Mirrors wasToolLoopInterrupted(latest persisted TR). When true, the reply
    // effect should fire even without new external events to drive the loop
    // forward (e.g. sleep / requiresFollowUp tool result waiting for the next
    // step). Initialized async on cold start, updated at the end of each cycle.
    const lastTRInterrupted = signal(false);
    void getLastProcessedTime(chatId).then(v => lastProcessedMs(Math.max(lastProcessedMs(), v)));
    void loadTRs(chatId).then(trs => lastTRInterrupted(wasToolLoopInterrupted(trs)));
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
      if (lastTRInterrupted()) return true;
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
            const ctx = composeContext(rcAtStart, trs, chatConfig.compaction.maxContextEstTokens, chatConfig.primary.model.model, sum);
            if (!ctx) return;

            log.withFields({
              chatId,
              entries: ctx.entries.length,
              estimatedTokens: ctx.estimatedTokens,
            }).log('Triggering LLM call');

            const messageExistsHere = (messageId: number) => deps.messageExists(chatId, messageId);

            const sendMessageTool = createSendMessageTool(async (text, replyTo, attachments) => {
              log.withFields({
                chatId,
                text: text.length > 100 ? `${text.slice(0, 100)}...` : text,
                replyTo,
                attachments: attachments?.length ?? 0,
              }).log('send_message tool called');
              const sent = await deps.sendMessage(chatId, text, replyTo ? Number(replyTo) : undefined, attachments);
              return { messageId: String(sent.messageId) };
            }, messageExistsHere);

            const downloadAttachment = createAttachmentDownloader({
              chatId,
              loadMessageAttachments: deps.loadMessageAttachments,
              downloadMessageMedia: deps.downloadMessageMedia,
            });

            const tools: CahciuaTool[] = [sendMessageTool, createReactTool((messageId, emoji) => deps.setMessageReaction(chatId, messageId, emoji), messageExistsHere)];
            tools.push(createBashTool(deps.runtimeConfig, {
              startTask: deps.backgroundTask.startTask,
              sessionId: chatId,
              backgroundThresholdSec: chatConfig.tools.bash.backgroundThresholdSec,
            }));
            if (chatConfig.tools.webSearch)
              tools.push(createWebSearchTool(createWebSearcher(chatConfig.tools.webSearch)));
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
            tools.push(createEndTurnTool());

            // --- Compute mention/reply/interrupt state from RC + TRs ---
            const rcVal = rcAtStart;
            const isInterrupted = wasToolLoopInterrupted(trs);
            // mention/reply skip the probe — those are de facto "should act" signals.
            // runtime events (background task completion) DO go through probe; the
            // judge can decide whether the result genuinely warrants surfacing.
            const isMentioned = rcVal.some(seg => seg.mentionsMe && seg.receivedAtMs > lastProcessedMs());
            const isReplied = rcVal.some(seg => seg.repliesToMe && seg.receivedAtMs > lastProcessedMs());
            const skipProbe = isInterrupted || isMentioned || isReplied;

            const activeBackgroundTasks = deps.backgroundTask.getActiveTasks(chatId);
            const timeNow = localTimeNow();
            // The probe's reason, when probe gated this primary call. Forwarded
            // to primary's late-binding as advisory context. Stays undefined
            // when probe was skipped (mention/replied/interrupted).
            let probeReason: string | undefined;

            // --- Probe gate ---
            if (!skipProbe) {
              log.withFields({ chatId, lastProcessedMs: lastProcessedMs() }).log('Running probe');

              const probeCtx = composeProbeContext(rcAtStart, trs, chatConfig.compaction.maxContextEstTokens, sum);
              if (!probeCtx) return;

              const probeSystem = await renderSystemPrompt({
                mode: 'probe',
                currentChannel: 'telegram',
                modelName: chatConfig.probe.model.model,
                chatId,
                chatTitle: deps.getChatTitle(chatId),
                systemFiles: chatConfig.systemFiles,
              });

              const probeEntries = [...probeCtx.entries];
              injectLateBindingPrompt(probeEntries, await renderLateBindingPrompt({
                mode: 'probe',
                timeNow,
                activeBackgroundTasks,
              }));

              const decideTool = createDecideTool();
              const probeRequestedAt = Date.now();
              const probeResult = await callLlm(
                { ...chatConfig.probe.model, forceToolChoice: { name: 'decide' } },
                probeEntries, probeSystem,
                [decideTool].map(toToolSchema),
                { log, label: `probe:${chatId}`, dumpId: `${chatId}.probe`, maxImagesAllowed: chatConfig.probe.model.maxImagesAllowed },
              );

              const decision = extractDecideResult(probeResult.entries);
              // No decide call (model failed to call the only tool) is treated as
              // silence — fail closed rather than activating primary on garbage.
              const shouldAct = decision?.should_act === true;

              log.withFields({ chatId, shouldAct, reason: decision?.reason }).log('Probe result');

              await deps.persistProbeResponse(chatId, {
                requestedAtMs: probeRequestedAt,
                entries: probeResult.entries,
                inputTokens: probeResult.usage.inputTokens,
                outputTokens: probeResult.usage.outputTokens,
                cacheReadTokens: probeResult.usage.cacheReadTokens,
                cacheWriteTokens: probeResult.usage.cacheWriteTokens,
                modelName: chatConfig.probe.model.model,
                isActivated: shouldAct,
                createdAt: Date.now(),
              });

              lastProcessedMs(probeRequestedAt);

              if (!shouldAct) return;
              probeReason = decision?.reason;
            }

            // We are committed to running primary now (probe passed, or was
            // skipped due to a de-facto act trigger). Start the "typing…"
            // action here — it covers the prep render + runStepLoop + the
            // optional fallback round. Refreshed every 5s since Telegram
            // clears the indicator after ~5s. Best-effort.
            let typingInterval: ReturnType<typeof setInterval> | undefined;
            if (deps.sendTypingAction && chatConfig.sendTypingAction) {
              void deps.sendTypingAction(chatId).catch(() => {});
              typingInterval = setInterval(() => {
                void deps.sendTypingAction!(chatId).catch(() => {});
              }, 5000);
            }

            try {
              const system = await renderSystemPrompt({
                mode: 'primary',
                currentChannel: 'telegram',
                modelName: chatConfig.primary.model.model,
                chatId,
                chatTitle: deps.getChatTitle(chatId),
                systemFiles: chatConfig.systemFiles,
              });

              injectLateBindingPrompt(ctx.entries, await renderLateBindingPrompt({
                mode: 'primary',
                timeNow,
                isInterrupted,
                activeBackgroundTasks,
                ...(probeReason ? { probeReason } : {}),
              }));

              const primaryTools = tools;

              const runner = getOrCreateRunner(chatConfig.primary.model);

              await runner.runStepLoop({
                chatId,
                entries: ctx.entries,
                system,
                tools: primaryTools,
                maxSteps: MAX_STEPS,
                maxImagesAllowed: chatConfig.primary.model.maxImagesAllowed,
                forceToolChoice: 'any',
                onStepComplete: async (stepEntries, usage, requestedAtMs) => {
                  await deps.persistTurnResponse(chatId, {
                    requestedAtMs,
                    entries: stepEntries,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cacheReadTokens: usage.cacheReadTokens,
                    cacheWriteTokens: usage.cacheWriteTokens,
                    modelName: chatConfig.primary.model.model,
                  });
                  lastProcessedMs(requestedAtMs);
                },
                checkInterrupt: () => {
                  if (rc() === rcAtStart) return false;
                  return latestExternalEventMs(rc(), lastProcessedMs()) != null;
                },
                log,
              });

              // Fallback: if this ReAct loop ended via end_turn but never
              // emitted a send_message, run one forced send_message step.
              // The bot is not told this is happening — same prompt, same
              // entries; only tool_choice differs at the API boundary.
              const latestTRs = await loadTRs(chatId, cursor);
              if (loopEndedWithoutSendMessage(latestTRs)) {
                log.withFields({ chatId }).log('Loop ended without send_message — running forced fallback');
                await runner.runStepLoop({
                  chatId,
                  entries: ctx.entries,
                  system,
                  tools: primaryTools,
                  maxSteps: 1,
                  maxImagesAllowed: chatConfig.primary.model.maxImagesAllowed,
                  forceToolChoice: { name: 'send_message' },
                  onStepComplete: async (stepEntries, usage, requestedAtMs) => {
                    await deps.persistTurnResponse(chatId, {
                      requestedAtMs,
                      entries: stepEntries,
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                      cacheReadTokens: usage.cacheReadTokens,
                      cacheWriteTokens: usage.cacheWriteTokens,
                      modelName: chatConfig.primary.model.model,
                    });
                    lastProcessedMs(requestedAtMs);
                  },
                  checkInterrupt: () => false,
                  log,
                });
              }
            } finally {
              if (typingInterval) clearInterval(typingInterval);
            }
          } catch (err) {
            // No retry or backoff — a failed call is recorded via failedRc and
            // only re-attempted when new external messages produce a fresh RC.
            log.withError(err).withFields({ chatId }).error('LLM call failed');
            failedRc(rcAtStart);
          } finally {
            // Refresh interrupted state from latest persisted TRs so the effect
            // re-fires for tool-loop continuation when needed (e.g. sleep returned
            // requiresFollowUp). Done before flipping running so the recompute
            // sees both signals updated atomically.
            try {
              const latestTRs = await loadTRs(chatId, cursorMs());
              lastTRInterrupted(wasToolLoopInterrupted(latestTRs));
            } catch (err) {
              log.withError(err).withFields({ chatId }).warn('Failed to refresh lastTRInterrupted');
            }
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
            const compactEndpoint = chatConfig.compaction.model ?? chatConfig.primary.model;

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
            log.withError(err).withFields({ chatId }).error('Compaction failed');
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
