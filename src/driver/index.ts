import { mkdirSync, writeFileSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';
import type { Message, Tool } from 'xsai';
import { chat, responseJSON } from 'xsai';

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

    const compatMatch = !!currentCompat && !!tr.reasoningSignatureCompat && tr.reasoningSignatureCompat === currentCompat;
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

  // Single chat completion API call via xsai. No automatic tool execution —
  // we handle tools and step control ourselves for full visibility.
  const chatCompletion = async (params: {
    messages: Message[];
    system?: string;
    tools?: Tool[];
  }) => {
    const res = await chat({
      baseURL: config.apiBaseUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages: params.messages,
      tools: params.tools,
      system: params.system,
    });

    return await responseJSON<{
      choices: Array<{ finish_reason: string; message: AnyMsg }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    }>(res);
  };

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
      reasoningSignatureCompat: r.reasoningSignatureCompat ?? '',
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

    let stepRequestedAt = Date.now();
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
      const tools = [sendMessageTool];

      // Manual step loop: one API call per iteration with manual tool execution.
      // Each step is persisted as its own TR immediately. Between steps we check
      // for new messages that should interrupt the current turn.
      let step = 0;
      while (step < MAX_STEPS) {
        step++;

        writeFileSync(`${DUMP_DIR}/${chatId}.request.json`, JSON.stringify({
          model: config.model, system, messages: currentMessages,
          tools: tools.map(t => ({ type: t.type, function: t.function })),
        }, null, 2));

        // Capture timestamp BEFORE the API call so events arriving during
        // the (potentially slow) request have receivedAtMs > requestedAtMs
        // and won't be missed by the self-loop check on the next turn.
        stepRequestedAt = Date.now();

        const response = await chatCompletion({ messages: currentMessages, system, tools });
        const choice = response.choices[0];

        if (!choice) {
          // Model stayed silent — persist empty TR to advance lastTrTime
          log.withFields({ chatId, step }).log('Model chose to stay silent (no choices)');
          persistTurnResponse(db, chatId, {
            requestedAtMs: stepRequestedAt,
            provider: 'openai-chat',
            data: [],
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          });
          break;
        }

        const assistantMsg = choice.message;
        const stepData: unknown[] = [assistantMsg];

        // Execute tools manually — we control this so every tool call and result
        // is visible in stepData and persisted in the TR.
        if (assistantMsg.tool_calls?.length) {
          for (const tc of assistantMsg.tool_calls) {
            const tool = tools.find(t => t.function.name === tc.function.name);
            try {
              const args = JSON.parse(tc.function.arguments);
              const result = tool
                ? await tool.execute(args, { messages: currentMessages, toolCallId: tc.id })
                : { error: `Unknown tool: ${tc.function.name}` };
              stepData.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: typeof result === 'string' ? result : JSON.stringify(result),
              });
            } catch (err) {
              log.withError(err).error(`Tool ${tc.function.name} failed`);
              stepData.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify({ error: String(err) }),
              });
            }
          }
        }

        log.withFields({
          chatId,
          step,
          finishReason: choice.finish_reason,
          hasToolCalls: !!assistantMsg.tool_calls?.length,
          newMessages: stepData.length,
          usage: response.usage,
        }).log('Step completed');

        // Persist this step as its own TR immediately
        persistTurnResponse(db, chatId, {
          requestedAtMs: stepRequestedAt,
          provider: 'openai-chat',
          data: stepData,
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
          reasoningSignatureCompat: config.reasoningSignatureCompat ?? '',
        });

        // No tool calls → model is done
        if (!assistantMsg.tool_calls?.length) break;

        // Model wants to continue — check for interruption by new events.
        // The TR we just saved is already durable, so prepareContext will
        // include it along with the new events.
        if (pendingRetrigger.has(chatId)) {
          pendingRetrigger.delete(chatId);
          log.withFields({ chatId, step }).log('Turn interrupted by new messages');

          const newCtx = prepareContext(chatId);
          if (!newCtx) return;

          currentMessages = newCtx.messages;
          system = await renderSystemPrompt({
            currentChannel: 'telegram',
            timeNow: new Date().toISOString(),
          });
          step = 0;
          continue;
        }

        // No interruption — append step data and continue
        currentMessages = [...currentMessages, ...stepData] as Message[];
      }
    } catch (err) {
      log.withError(err).error('LLM call failed');
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
