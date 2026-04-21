import type { Logger } from '@guiiai/logg';
import { computed, effect, signal } from 'alien-signals';

import { callLlm, type ToolSchema } from './call-llm';
import { runCompaction } from './compaction';
import { composeContext, findWorkingWindowCursor, injectLateBindingPrompt, latestExternalEventMs, wasToolLoopInterrupted } from './context';
import { renderLateBindingPrompt, renderSystemPrompt } from './prompt';
import { createRunner } from './runner';
import { collectRecentSendMessageAssessments, renderRecentSendMessageHumanLikenessXml } from './send-message-human-likeness';
import { createBashTool, createAttachmentDownloader, createDownloadFileTool, createKillTaskTool, createReadImageTool, createReadTaskOutputTool, createSendMessageTool, createWebSearchTool } from './tools';
import type { CahciuaTool, SendMessageAttachment } from './tools';
import type { CompactionSessionMeta, DriverConfig, LlmEndpoint, ProbeResponseV2, ProviderFormat, TurnResponseV2 } from './types';
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
  loadCompaction: (chatId: string) => CompactionSessionMeta | null;
  loadLastProbeTime: (chatId: string) => number;
  persistCompaction: (chatId: string, meta: CompactionSessionMeta) => void;
  setCompactCursor: (chatId: string, cursorMs: number) => RenderedContext | undefined;
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
  const getOrCreateRunner = (endpoint: { apiBaseUrl: string; apiKey: string; model: string; apiFormat?: ProviderFormat; timeoutSec?: number }) => {
    const key = `${endpoint.apiBaseUrl}::${endpoint.model}`;
    let runner = runners.get(key);
    if (!runner) {
      runner = createRunner({
        apiBaseUrl: endpoint.apiBaseUrl,
        apiKey: endpoint.apiKey,
        model: endpoint.model,
        apiFormat: endpoint.apiFormat ?? 'openai-chat',
        timeoutSec: endpoint.timeoutSec,
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

            const tools: CahciuaTool[] = [sendMessageTool];
            tools.push(createBashTool(deps.runtimeConfig, {
              startTask: deps.backgroundTask.startTask,
              sessionId: chatId,
              backgroundThresholdSec: chatConfig.tools.bash.backgroundThresholdSec,
            }));
            tools.push(createWebSearchTool(chatConfig.tools.webSearch.tavilyKey));
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

            const system = await renderSystemPrompt({
              currentChannel: 'telegram',
              modelName: chatConfig.primaryModel.model,
            });

            // --- Compute mention/reply/interrupt state from RC + TRs ---
            const rcVal = rcAtStart;
            const isInterrupted = wasToolLoopInterrupted(trs);
            const lastMentionedAtMs = rcVal.reduce((max, seg) =>
              (seg.mentionsMe || seg.repliesToMe || seg.isRuntimeEvent) ? Math.max(max, seg.receivedAtMs) : max, 0);
            const isMentioned = rcVal.some(seg => seg.mentionsMe && seg.receivedAtMs > lastProcessedMs());
            const isReplied = rcVal.some(seg => seg.repliesToMe && seg.receivedAtMs > lastProcessedMs());
            const recentSendMessageHumanLikenessXml = renderRecentSendMessageHumanLikenessXml(
              collectRecentSendMessageAssessments(await deps.loadTurnResponses(chatId)),
            );

            const lateBindingParams = {
              timeNow: localTimeNow(),
              isMentioned, isReplied,
              recentSendMessageHumanLikenessXml,
              isInterrupted,
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
                    && e.parts.some(p => p.kind === 'toolCall'),
                );

                log.withFields({ chatId, hasToolCalls }).log('Probe result');

                await deps.persistProbeResponse(chatId, {
                  requestedAtMs: probeRequestedAt,
                  entries: probeResult.entries,
                  inputTokens: probeResult.usage.inputTokens,
                  outputTokens: probeResult.usage.outputTokens,
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
                  inputTokens: usage.prompt_tokens,
                  outputTokens: usage.completion_tokens,
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
          } catch (err) {
            // No retry or backoff — a failed call is recorded via failedRc and
            // only re-attempted when new external messages produce a fresh RC.
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
