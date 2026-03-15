import type { Message } from 'xsai';

import { mergeContext } from './merge';
import type { TRAssistantEntry, TRDataEntry, TurnResponse } from './types';
import type { FeatureFlags } from '../config/config';
import type { RenderedContext } from '../rendering/types';

type AnyMsg = Record<string, any>;
const asMsg = (m: Message): AnyMsg => m as unknown as AnyMsg;

// ~2 chars per token for mixed CJK/English/XML.
// For images, use actual base64 URL length (dominates HTTP payload).
const CHARS_PER_TOKEN = 2;

// Image token estimation: thumbnails are generated at ≤75,000 pixels
// (see telegram/thumbnail.ts), which maps to ~100 tokens under Claude's
// formula (ceil(w*h/750)). We don't have image dimensions at estimation
// time, so use a fixed constant matching our thumbnail budget.
const IMAGE_TOKENS = 100;

const estimatePartTokens = (part: Record<string, any>): number => {
  if (part.type === 'image_url' || (part.type === 'image' && part.source))
    return IMAGE_TOKENS;
  return Math.ceil(((part.text as string)?.length ?? 0) / CHARS_PER_TOKEN);
};

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
// Preserves tool_call -> tool_result adjacency.
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
//   - Same compat group  -> keep all reasoning (signature valid, model can resume)
//   - Different / empty  -> strip all reasoning (signature invalid, would error)
//
// The pair is always kept or stripped together — never one without the other.
const sanitizeReasoningForTR = (tr: TurnResponse, currentCompat: string | undefined): TRDataEntry[] =>
  tr.data.map(entry => {
    if (entry.role !== 'assistant') return entry;

    const compatMatch = !!currentCompat && !!tr.reasoningSignatureCompat && tr.reasoningSignatureCompat === currentCompat;
    if (compatMatch) return entry;

    // Compat mismatch — strip all reasoning fields, keeping only role/content/tool_calls
    const rest: TRAssistantEntry = { role: 'assistant' };
    if (entry.content !== undefined) rest.content = entry.content;
    if (entry.tool_calls) rest.tool_calls = entry.tool_calls;

    // Strip thinking blocks from content array
    if (Array.isArray(rest.content)) {
      const filtered = rest.content.filter(part =>
        typeof part !== 'object' || part === null || !('type' in part) || part.type !== 'thinking');
      rest.content = filtered.length > 0 ? filtered : undefined;
    }

    // Anthropic rejects empty-string text content blocks — normalize to undefined
    if (rest.content === '' || rest.content === null) rest.content = undefined;

    return rest;
  });

// Returns the receivedAtMs of the latest external message after afterMs,
// or null if there are none. Replaces hasNewExternalMessages — one function
// answers both "any new?" (!= null) and "when was the latest?" (the value).
export const latestExternalEventMs = (
  rc: RenderedContext,
  afterMs: number,
): number | null => {
  let latest: number | null = null;
  for (const seg of rc) {
    if (seg.receivedAtMs > afterMs && !seg.isMyself)
      latest = seg.receivedAtMs > (latest ?? 0) ? seg.receivedAtMs : latest;
  }
  return latest;
};

// Walk backward from the newest RC segment, accumulate estimated tokens
// from both RC and TRs (interleaved by timestamp), stop when the budget
// is reached. Returns the receivedAtMs of the cutoff point.
// Previous version only counted RC tokens, causing TRs to push the total
// over budget and immediately re-trigger compaction.
export const findWorkingWindowCursor = (
  rc: RenderedContext, trs: TurnResponse[], budgetTokens: number,
): number => {
  // Build a unified timeline of token costs, sorted newest-first
  type Entry = { timeMs: number; tokens: number };
  const entries: Entry[] = [];

  for (const seg of rc) {
    const tokens = seg.content.reduce((a, p) =>
      a + (p.type === 'text' ? Math.ceil(p.text.length / CHARS_PER_TOKEN) : IMAGE_TOKENS), 0);
    entries.push({ timeMs: seg.receivedAtMs, tokens });
  }

  for (const tr of trs) {
    const tokens = tr.data.reduce((a, entry) =>
      a + Math.ceil(JSON.stringify(entry).length / CHARS_PER_TOKEN), 0);
    entries.push({ timeMs: tr.requestedAtMs, tokens });
  }

  // Sort newest-first
  entries.sort((a, b) => b.timeMs - a.timeMs);

  let accum = 0;
  for (const entry of entries) {
    accum += entry.tokens;
    if (accum > budgetTokens) return entry.timeMs;
  }
  return entries.at(-1)?.timeMs ?? 0;
};

// --- Feature flag: trimStaleNoToolCallTurnResponses ---
// TRs without tool calls (pure text responses) contribute less to context quality.
// Keep only the latest N, trim older ones before merge.
const KEEP_NO_TOOL_CALL_TRS = 5;

const trHasToolCalls = (tr: TurnResponse): boolean =>
  tr.data.some(entry =>
    entry.role === 'assistant' && Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0);

const trimStaleNoToolCallTRs = (trs: TurnResponse[]): TurnResponse[] => {
  // Partition: indices of TRs without tool calls
  const noToolIndices: number[] = [];
  for (let i = 0; i < trs.length; i++) {
    if (!trHasToolCalls(trs[i]!)) noToolIndices.push(i);
  }

  if (noToolIndices.length <= KEEP_NO_TOOL_CALL_TRS) return trs;

  // Drop oldest no-tool-call TRs, keeping the latest N
  const dropSet = new Set(noToolIndices.slice(0, noToolIndices.length - KEEP_NO_TOOL_CALL_TRS));
  return trs.filter((_, i) => !dropSet.has(i));
};

// --- Feature flag: trimToolResults ---
// Tool result trimming — distance-based mechanical trimming of TRToolResultEntry.content.
// Keeps TRAssistantEntry (call structure + reasoning) intact.
// Unlike OpenClaw's context pruning, no head protection needed — Cahciua injects
// identity via system prompt, not via bootstrap tool calls before first user message.
const TOOL_RESULT_TRIM_THRESHOLD = 512; // chars — results shorter than this are kept
const TOOL_RESULT_KEEP_RECENT = 2;      // keep last N TRs' tool results untrimmed

const trimToolResults = (trs: TurnResponse[]): TurnResponse[] => {
  if (trs.length <= TOOL_RESULT_KEEP_RECENT) return trs;

  return trs.map((tr, i) => {
    if (i >= trs.length - TOOL_RESULT_KEEP_RECENT) return tr;
    const data = tr.data.map((entry): TRDataEntry => {
      if (entry.role !== 'tool') return entry;
      if (entry.content.length <= TOOL_RESULT_TRIM_THRESHOLD) return entry;
      const head = entry.content.slice(0, 200);
      const tail = entry.content.slice(-200);
      return { ...entry, content: `${head}\n... [trimmed ${entry.content.length} chars] ...\n${tail}` };
    });
    return { ...tr, data };
  });
};

// --- Feature flag: trimSelfMessagesCoveredBySendToolCalls ---
// Bot's own messages enter RC via userbot AND exist in TRs as tool call results.
// Filter RC segments marked isSelfSent=true to remove the duplicate representation.
const filterSelfSentSegments = (rc: RenderedContext): RenderedContext =>
  rc.filter(seg => !seg.isSelfSent);

// Drop excess image_url parts from messages (oldest first) to stay within
// a model's image limit. Mutates the messages array in place.
export const trimImages = (messages: Message[], maxImages: number): void => {
  // Count total images
  let total = 0;
  for (const msg of messages) {
    const m = asMsg(msg);
    if (Array.isArray(m.content))
      total += (m.content as AnyMsg[]).filter(p => p.type === 'image_url').length;
  }
  if (total <= maxImages) return;

  // Drop from the front (oldest messages first)
  let toDrop = total - maxImages;
  for (const msg of messages) {
    if (toDrop <= 0) break;
    const m = asMsg(msg);
    if (!Array.isArray(m.content)) continue;
    const before = m.content.length;
    m.content = (m.content as AnyMsg[]).filter(p => {
      if (toDrop > 0 && p.type === 'image_url') { toDrop--; return false; }
      return true;
    });
    // If user message has no content left, push a placeholder
    if (m.content.length === 0 && before > 0)
      m.content = [{ type: 'text', text: '[images omitted]' }];
  }
};

export const composeContext = (
  rc: RenderedContext,
  trs: TurnResponse[],
  maxTokens: number,
  reasoningSignatureCompat: string | undefined,
  featureFlags?: FeatureFlags,
  compactSummary?: string,
): { messages: Message[]; estimatedTokens: number; rawEstimatedTokens: number } | null => {
  let effectiveRC = rc;
  if (featureFlags?.trimSelfMessagesCoveredBySendToolCalls)
    effectiveRC = filterSelfSentSegments(effectiveRC);

  let sanitizedTRs = trs.map(tr => ({
    ...tr,
    data: sanitizeReasoningForTR(tr, reasoningSignatureCompat),
  }));

  if (featureFlags?.trimStaleNoToolCallTurnResponses)
    sanitizedTRs = trimStaleNoToolCallTRs(sanitizedTRs);

  if (featureFlags?.trimToolResults)
    sanitizedTRs = trimToolResults(sanitizedTRs);

  const allMessages = mergeContext(effectiveRC, sanitizedTRs);
  if (allMessages.length === 0 && !compactSummary) return null;

  if (compactSummary)
    allMessages.unshift({ role: 'user', content: `[Conversation summary]\n${compactSummary}` } as Message);

  // Anthropic rejects empty text content blocks (content: "", null, or undefined
  // on assistant messages). Normalize: delete content key when it's empty so the
  // message only carries tool_calls. For user/tool roles this shouldn't happen,
  // but guard defensively.
  for (const msg of allMessages) {
    const m = msg as Record<string, any>;
    if (m.content === '' || m.content === null || m.content === undefined)
      delete m.content;
  }

  // Drop assistant messages that became completely empty after reasoning stripping
  // (pure-thinking entries with no content and no tool_calls).
  const cleaned = allMessages.filter(msg => {
    const m = msg as Record<string, any>;
    return !(m.role === 'assistant' && !('content' in m) && !m.tool_calls);
  });

  const rawEstimatedTokens = cleaned.reduce((acc, msg) => acc + estimateMessageTokens(asMsg(msg)), 0);
  const trimmed = trimContext(cleaned, maxTokens);
  return { ...trimmed, rawEstimatedTokens };
};
