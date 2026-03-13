import { mkdirSync, writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';
import type { Message } from 'xsai';
import { generateText } from 'xsai';

import { mergeContext } from './merge';
import { renderSystemPrompt } from './prompt';
import { createSendMessageTool } from './tools';
import type { DriverConfig, TurnResponse } from './types';
import type { DB } from '../db/client';
import { loadTurnResponses, persistTurnResponse } from '../db/persistence';
import type { RenderedContext } from '../rendering/types';

export { mergeContext } from './merge';
export { renderSystemPrompt } from './prompt';
export type { DriverConfig, TurnResponse } from './types';

const DUMP_DIR = '/tmp/cahciua';
mkdirSync(DUMP_DIR, { recursive: true });

const DEBOUNCE_MS = 2000;
const MAX_STEPS = 5;

// Token estimation: ~2 chars per token for mixed CJK/English/XML.
// For images, use actual base64 URL length (dominates HTTP payload).
const CHARS_PER_TOKEN = 2;

const estimatePartTokens = (part: Record<string, any>): number => {
  if (part.type === 'image_url' && part.image_url?.url)
    return Math.ceil((part.image_url.url as string).length / CHARS_PER_TOKEN);
  return Math.ceil(((part.text as string)?.length ?? 0) / CHARS_PER_TOKEN);
};

type AnyMsg = Record<string, any>;
const asMsg = (m: Message): AnyMsg => m as unknown as AnyMsg;

const estimateMessageTokens = (m: AnyMsg): number => {
  if (Array.isArray(m.content))
    return (m.content as AnyMsg[]).reduce((a, p) => a + estimatePartTokens(p), 0);
  if (typeof m.content === 'string')
    return Math.ceil(m.content.length / CHARS_PER_TOKEN);
  return Math.ceil(JSON.stringify(m).length / CHARS_PER_TOKEN);
};

// Trim merged messages to fit within a token budget.
// Drops from the front (oldest first). For user messages, trims individual
// content parts; for assistant/tool messages, drops entire messages.
// Preserves tool_call → tool_result adjacency.
const trimContext = (messages: Message[], maxTokens: number): { messages: Message[]; estimatedTokens: number } => {
  let totalTokens = messages.reduce((acc, msg) => acc + estimateMessageTokens(asMsg(msg)), 0);

  if (totalTokens <= maxTokens) return { messages, estimatedTokens: totalTokens };

  // Deep-clone user messages' content arrays for mutation
  const result = messages.map(msg =>
    asMsg(msg).role === 'user' && Array.isArray(asMsg(msg).content)
      ? { ...msg, content: [...asMsg(msg).content] }
      : msg) as Message[];

  while (totalTokens > maxTokens) {
    const first = asMsg(result[0]!);

    if (first.role === 'user' && Array.isArray(first.content) && first.content.length > 0) {
      // Keep at least the last content part of the last message
      if (first.content.length <= 1 && result.length <= 1) break;

      const dropped = first.content.shift() as AnyMsg;
      totalTokens -= estimatePartTokens(dropped);

      // User message emptied — remove it
      if (first.content.length === 0) result.shift();
    } else if (result.length > 1) {
      const dropped = asMsg(result.shift()!);
      totalTokens -= estimateMessageTokens(dropped);

      // If dropped an assistant with tool_calls, also drop following tool results
      if (dropped.tool_calls) {
        while (result.length > 0 && asMsg(result[0]!).role === 'tool') {
          totalTokens -= estimateMessageTokens(asMsg(result.shift()!));
        }
      }
    } else {
      break;
    }
  }

  // Don't start with orphaned tool results
  while (result.length > 1 && asMsg(result[0]!).role === 'tool')
    result.shift();

  return { messages: result, estimatedTokens: totalTokens };
};

// Sanitize reasoning from historical TRs before merging into LLM context.
//
// Anthropic models return reasoning as thinking text + cryptographic signature.
// The signature validates that the thinking text hasn't been tampered with;
// replaying requires BOTH — signature alone is useless without the text it signs.
//
// In OpenAI Chat Completions compatible format, this pair appears as:
//   - reasoning_text  (the thinking text)     + reasoning_opaque (the signature)
// In Anthropic native content-array format:
//   - thinking block with `thinking` field    + `signature` field
//
// Signatures are only valid within the same provider family (e.g. "anthropic").
// Each TR records which compat group produced it. On replay:
//   - Same compat group  → keep all reasoning (signature valid, model can resume)
//   - Different / empty  → strip all reasoning (signature invalid, would error)
//
// The pair is always kept or stripped together — never one without the other.
const sanitizeReasoningForTR = (tr: TurnResponse, currentCompat: string | undefined): unknown[] =>
  tr.data.map(entry => {
    const m = entry as AnyMsg;
    if (m.role !== 'assistant') return entry;

    const compatMatch = !!currentCompat && !!tr.reasoningCompat && tr.reasoningCompat === currentCompat;
    if (compatMatch) return entry;

    // Compat mismatch — strip all reasoning
    let result = { ...m };
    if ('reasoning_text' in result)
      delete result.reasoning_text;
    if ('reasoning_opaque' in result)
      delete result.reasoning_opaque;

    // Strip thinking blocks from content array
    if (Array.isArray(result.content)) {
      const filtered = (result.content as AnyMsg[]).filter(part => part.type !== 'thinking');
      if (filtered.length !== result.content.length)
        result = { ...result, content: filtered.length > 0 ? filtered : '' };
    }

    return result;
  });

export const createDriver = (config: DriverConfig, deps: {
  db: DB;
  sendMessage: (chatId: string, text: string, replyToMessageId?: number) => Promise<{ messageId: number; date: number }>;
  logger: Logger;
}) => {
  const { db, logger } = deps;
  const log = logger.withContext('driver');
  const chatIds = new Set(config.chatIds);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  // The latest RC per chat, updated by handleEvent
  const latestRC = new Map<string, RenderedContext>();

  // Concurrency guard: prevent parallel LLM calls for the same chat.
  // If events arrive during an in-flight call, pendingRetrigger ensures
  // a follow-up call with the latest RC once the current one completes.
  const running = new Set<string>();
  const pendingRetrigger = new Set<string>();

  // Load RC + TRs, run self-loop check, sanitize reasoning, merge and trim.
  // Returns null if nothing to do (no RC, no new external messages).
  const prepareContext = (chatId: string) => {
    const rc = latestRC.get(chatId);
    if (!rc || rc.length === 0) return null;

    const trRows = loadTurnResponses(db, chatId);
    const trs: TurnResponse[] = trRows.map(r => ({
      requestedAtMs: r.requestedAt,
      provider: r.provider,
      data: r.data,
      sessionMeta: r.sessionMeta,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      reasoningCompat: r.reasoningCompat ?? '',
    }));

    // Self-loop prevention: skip if all RC segments after the last TR are from bot
    const lastTrTime = trs.length > 0 ? trs[trs.length - 1]!.requestedAtMs : 0;
    const newSegments = rc.filter(seg => seg.receivedAtMs > lastTrTime);
    const hasExternal = newSegments.some(seg => !seg.isMyself);

    log.withFields({
      chatId,
      lastTrTime,
      trs: trs.length,
      totalSegments: rc.length,
      newSegments: newSegments.length,
      newExternal: newSegments.filter(seg => !seg.isMyself).length,
      newMyself: newSegments.filter(seg => !!seg.isMyself).length,
      hasExternal,
    }).log('Self-loop check');

    if (!hasExternal) {
      log.withFields({ chatId }).log('Skipping: no new external messages');
      return null;
    }

    const sanitizedTRs = trs.map(tr => ({
      ...tr,
      data: sanitizeReasoningForTR(tr, config.reasoningSignatureCompat),
    }));

    const allMessages = mergeContext(rc, sanitizedTRs);
    if (allMessages.length === 0) return null;

    const { messages, estimatedTokens } = trimContext(allMessages, config.maxContextTokens);

    log.withFields({
      chatId,
      messages: messages.length,
      estimatedTokens,
    }).log('Context prepared');

    return { messages };
  };

  const triggerLLMCall = async (chatId: string) => {
    if (running.has(chatId)) {
      pendingRetrigger.add(chatId);
      return;
    }

    const ctx = prepareContext(chatId);
    if (!ctx) return;

    running.add(chatId);
    log.withFields({ chatId }).log('Triggering LLM call');

    // Accumulators for the current turn — outside try so catch can access them
    let requestedAtMs = Date.now();
    let accNewMessages: unknown[] = [];
    let accInputTokens = 0;
    let accOutputTokens = 0;

    try {
      let currentMessages = ctx.messages;
      let system = await renderSystemPrompt({
        currentChannel: 'telegram',
        timeNow: new Date().toISOString(),
      });

      const sendMessageTool = createSendMessageTool(async (text, replyTo) => {
        log.withFields({ chatId, text: text.length > 100 ? `${text.slice(0, 100)}...` : text, replyTo }).log('send_message tool called');
        await deps.sendMessage(chatId, text, replyTo ? Number(replyTo) : undefined);
      });

      // Manual step loop: one LLM call per iteration (xsai maxSteps defaults to 1).
      // Tools are executed within each step, but the model doesn't see tool results
      // until the next iteration. Between steps we check for new messages that should
      // interrupt the current turn — if found, persist the partial TR and start a
      // new turn with fresh context (including the new events).
      let step = 0;
      while (step < MAX_STEPS) {
        step++;

        writeFileSync(`${DUMP_DIR}/${chatId}.request.json`, JSON.stringify({ system, messages: currentMessages }, null, 2));

        const result = await generateText({
          baseURL: config.apiBaseUrl,
          apiKey: config.apiKey,
          model: config.model,
          messages: currentMessages,
          system,
          tools: [sendMessageTool],
        });

        const stepNewMsgs = result.messages.slice(currentMessages.length);
        accNewMessages.push(...stepNewMsgs);
        accInputTokens += result.usage.prompt_tokens;
        accOutputTokens += result.usage.completion_tokens;

        log.withFields({
          chatId,
          step,
          finishReason: result.finishReason,
          newMessages: stepNewMsgs.length,
          usage: result.usage,
        }).log('Step completed');

        // Check if model wants to continue (last new message is a tool result
        // that needs to be fed back to the model in the next step)
        const lastNewMsg = stepNewMsgs[stepNewMsgs.length - 1] as AnyMsg | undefined;
        if (lastNewMsg?.role !== 'tool') break;

        // Model wants to continue — check for interruption by new events.
        // If new messages arrived during this step, interrupt the current turn:
        // persist the partial TR (tool calls + results so far) and start fresh
        // with the new events merged into context. This lets the model see new
        // user messages ASAP instead of waiting for the entire tool loop to finish.
        if (pendingRetrigger.has(chatId)) {
          pendingRetrigger.delete(chatId);
          log.withFields({ chatId, step }).log('Turn interrupted by new messages');

          // Persist current turn before starting new one
          if (accNewMessages.length > 0) {
            persistTurnResponse(db, chatId, {
              requestedAtMs,
              provider: 'openai-chat',
              data: accNewMessages,
              inputTokens: accInputTokens,
              outputTokens: accOutputTokens,
              reasoningCompat: config.reasoningSignatureCompat ?? '',
            });
          }

          // Re-prepare context with new events + the TR we just saved
          const newCtx = prepareContext(chatId);
          if (!newCtx) return;

          currentMessages = newCtx.messages;
          system = await renderSystemPrompt({
            currentChannel: 'telegram',
            timeNow: new Date().toISOString(),
          });

          // Reset accumulators for new turn
          accNewMessages = [];
          accInputTokens = 0;
          accOutputTokens = 0;
          requestedAtMs = Date.now();
          step = 0;
          continue;
        }

        // No interruption — feed tool results back to model in next step
        currentMessages = result.messages as Message[];
      }

      // Persist final turn
      if (accNewMessages.length > 0) {
        persistTurnResponse(db, chatId, {
          requestedAtMs,
          provider: 'openai-chat',
          data: accNewMessages,
          inputTokens: accInputTokens,
          outputTokens: accOutputTokens,
          reasoningCompat: config.reasoningSignatureCompat ?? '',
        });
      }
    } catch (err) {
      // "No choices returned" = model decided to stay silent (e.g. Claude returns
      // empty choices with only 2 completion tokens for the stop sequence).
      // Persist accumulated messages (or empty TR to advance lastTrTime).
      if (err instanceof Error && err.message.includes('No choices returned')) {
        log.withFields({ chatId }).log('Model chose to stay silent (no choices returned)');
        persistTurnResponse(db, chatId, {
          requestedAtMs,
          provider: 'openai-chat',
          data: accNewMessages,
          inputTokens: accInputTokens,
          outputTokens: accOutputTokens,
        });
      } else {
        log.withError(err).error('LLM call failed');
        // Persist accumulated messages if any (tool side effects already executed)
        if (accNewMessages.length > 0) {
          persistTurnResponse(db, chatId, {
            requestedAtMs,
            provider: 'openai-chat',
            data: accNewMessages,
            inputTokens: accInputTokens,
            outputTokens: accOutputTokens,
            reasoningCompat: config.reasoningSignatureCompat ?? '',
          });
        }
      }
    } finally {
      running.delete(chatId);
      if (pendingRetrigger.has(chatId)) {
        pendingRetrigger.delete(chatId);
        void triggerLLMCall(chatId);
      }
    }
  };

  const handleEvent = (chatId: string, rc: RenderedContext) => {
    if (!chatIds.has(chatId)) return;

    latestRC.set(chatId, rc);

    // Debounce: reset timer on each event
    const existing = timers.get(chatId);
    if (existing) clearTimeout(existing);

    timers.set(chatId, setTimeout(() => {
      timers.delete(chatId);
      void triggerLLMCall(chatId);
    }, DEBOUNCE_MS));
  };

  const stop = () => {
    for (const timer of timers.values())
      clearTimeout(timer);
    timers.clear();
  };

  return { handleEvent, stop };
};
