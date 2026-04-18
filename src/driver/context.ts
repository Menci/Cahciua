import { mergeContext } from './merge';
import type { TurnResponseV2 } from './types';
import type { FeatureFlags } from '../config/config';
import type { RenderedContext } from '../rendering/types';
import { stripReasoning } from '../unified-api/reasoning';
import type {
  ConversationEntry,
  InputMessage,
  InputPart,
  OutputMessage,
  ToolCallPart,
  ToolResult,
} from '../unified-api/types';

// ~2 chars per token for mixed CJK/English/XML.
const CHARS_PER_TOKEN = 2;
// Image token estimation: thumbnails ≤ 75_000 px → ~100 tokens (Claude formula).
const IMAGE_TOKENS = 100;

const partTokens = (part: InputPart): number =>
  part.kind === 'image' ? IMAGE_TOKENS : Math.ceil(part.text.length / CHARS_PER_TOKEN);

const toolResultTokens = (tr: ToolResult): number =>
  typeof tr.payload === 'string'
    ? Math.ceil(tr.payload.length / CHARS_PER_TOKEN)
    : tr.payload.reduce((a, p) => a + partTokens(p), 0);

const outputPartTokens = (part: OutputMessage['parts'][number]): number => {
  if (part.kind === 'text') return Math.ceil(part.text.length / CHARS_PER_TOKEN);
  if (part.kind === 'toolCall') return Math.ceil((part.name.length + part.args.length) / CHARS_PER_TOKEN);
  if (part.kind === 'textGroup') return part.content.reduce((a, t) => a + Math.ceil(t.text.length / CHARS_PER_TOKEN), 0);
  return 20; // reasoning — rough
};

const entryTokens = (e: ConversationEntry): number => {
  if (e.kind === 'toolResult') return toolResultTokens(e);
  if (e.role === 'assistant') return e.parts.reduce((a, p) => a + outputPartTokens(p), 0);
  return e.parts.reduce((a, p) => a + partTokens(p), 0);
};

export const latestExternalEventMs = (rc: RenderedContext, afterMs: number): number | null => {
  let latest: number | null = null;
  for (const seg of rc) {
    if (seg.receivedAtMs > afterMs && !seg.isMyself)
      latest = seg.receivedAtMs > (latest ?? 0) ? seg.receivedAtMs : latest;
  }
  return latest;
};

const trHasToolCalls = (tr: TurnResponseV2): boolean =>
  tr.entries.some(e => e.kind === 'message' && e.role === 'assistant'
    && e.parts.some(p => p.kind === 'toolCall'));

/** Was the last TR interrupted? (ends with a requiresFollowUp ToolResult) */
export const wasToolLoopInterrupted = (trs: TurnResponseV2[]): boolean => {
  if (trs.length === 0) return false;
  const entries = trs[trs.length - 1]!.entries;
  const toolResults = entries.filter((e): e is ToolResult => e.kind === 'toolResult');
  if (toolResults.length === 0) return false;
  return toolResults.some(tr => tr.requiresFollowUp);
};

// --- Feature flag: trimStaleNoToolCallTurnResponses ---
const KEEP_NO_TOOL_CALL_TRS = 5;

const trimStaleNoToolCallTRs = (trs: TurnResponseV2[]): TurnResponseV2[] => {
  const noToolIndices: number[] = [];
  for (let i = 0; i < trs.length; i++)
    if (!trHasToolCalls(trs[i]!)) noToolIndices.push(i);
  if (noToolIndices.length <= KEEP_NO_TOOL_CALL_TRS) return trs;
  const dropSet = new Set(noToolIndices.slice(0, noToolIndices.length - KEEP_NO_TOOL_CALL_TRS));
  return trs.filter((_, i) => !dropSet.has(i));
};

// --- Feature flag: trimToolResults ---
const TOOL_RESULT_TRIM_THRESHOLD = 512;
const TOOL_RESULT_KEEP_RECENT_OVERSIZED = 5;

const trimLongText = (text: string): string =>
  text.length <= TOOL_RESULT_TRIM_THRESHOLD ? text
    : `${text.slice(0, 200)}\n... [trimmed ${text.length} chars] ...\n${text.slice(-200)}`;

const joinToolResultText = (parts: InputPart[]): string =>
  parts.flatMap(p => p.kind === 'text' ? [p.text] : []).join('\n');

const toolResultExceedsLimit = (tr: ToolResult): boolean => {
  if (typeof tr.payload === 'string') return tr.payload.length > TOOL_RESULT_TRIM_THRESHOLD;
  return joinToolResultText(tr.payload).length > TOOL_RESULT_TRIM_THRESHOLD
    || tr.payload.some(p => p.kind === 'image' && p.detail !== 'low');
};

const trimToolResultPayload = (tr: ToolResult): ToolResult => {
  if (typeof tr.payload === 'string') return { ...tr, payload: trimLongText(tr.payload) };
  const joined = joinToolResultText(tr.payload);
  const shouldTrimText = joined.length > TOOL_RESULT_TRIM_THRESHOLD;
  const trimmed = shouldTrimText ? trimLongText(joined) : null;
  let emitted = false;
  const newParts: InputPart[] = tr.payload.flatMap((p): InputPart[] => {
    if (p.kind === 'image') return [{ ...p, detail: 'low' as const }];
    if (!shouldTrimText) return [p];
    if (emitted) return [];
    emitted = true;
    return [{ ...p, text: trimmed! }];
  });
  return { ...tr, payload: newParts };
};

const trimToolResults = (trs: TurnResponseV2[]): TurnResponseV2[] => {
  const positions: Array<{ trIndex: number; entryIndex: number }> = [];
  for (let ti = 0; ti < trs.length; ti++) {
    const entries = trs[ti]!.entries;
    for (let ei = 0; ei < entries.length; ei++) {
      const e = entries[ei]!;
      if (e.kind === 'toolResult' && toolResultExceedsLimit(e))
        positions.push({ trIndex: ti, entryIndex: ei });
    }
  }
  if (positions.length <= TOOL_RESULT_KEEP_RECENT_OVERSIZED) return trs;
  const toTrim = new Map<number, Set<number>>();
  for (const { trIndex, entryIndex } of positions.slice(0, positions.length - TOOL_RESULT_KEEP_RECENT_OVERSIZED)) {
    const set = toTrim.get(trIndex) ?? new Set<number>();
    set.add(entryIndex);
    toTrim.set(trIndex, set);
  }
  return trs.map((tr, ti) => {
    const set = toTrim.get(ti);
    if (!set) return tr;
    return {
      ...tr,
      entries: tr.entries.map((e, ei) =>
        e.kind === 'toolResult' && set.has(ei) ? trimToolResultPayload(e) : e),
    };
  });
};

// --- Feature flag: trimSelfMessagesCoveredBySendToolCalls ---
const filterSelfSentSegments = (rc: RenderedContext): RenderedContext =>
  rc.filter(seg => !seg.isSelfSent);

/**
 * Walk backward through RC + TR timeline until budget is reached.
 * Returns receivedAtMs of the cutoff point (entries newer than it stay).
 */
export const findWorkingWindowCursor = (
  rc: RenderedContext, trs: TurnResponseV2[], budgetTokens: number,
): number => {
  type Entry = { timeMs: number; tokens: number };
  const entries: Entry[] = [];
  for (const seg of rc) {
    const tokens = seg.content.reduce((a, p) =>
      a + (p.type === 'text' ? Math.ceil(p.text.length / CHARS_PER_TOKEN) : IMAGE_TOKENS), 0);
    entries.push({ timeMs: seg.receivedAtMs, tokens });
  }
  for (const tr of trs) {
    const tokens = tr.entries.reduce((a, e) => a + entryTokens(e), 0);
    entries.push({ timeMs: tr.requestedAtMs, tokens });
  }
  entries.sort((a, b) => b.timeMs - a.timeMs);
  let accum = 0;
  for (const entry of entries) {
    accum += entry.tokens;
    if (accum > budgetTokens) return entry.timeMs;
  }
  return entries.at(-1)?.timeMs ?? 0;
};

const trimEntries = (entries: ConversationEntry[], maxTokens: number): { entries: ConversationEntry[]; estimatedTokens: number } => {
  let total = entries.reduce((a, e) => a + entryTokens(e), 0);
  if (total <= maxTokens) return { entries, estimatedTokens: total };

  // Deep-clone the first user InputMessage's parts for in-place trimming
  const result: ConversationEntry[] = entries.map(e =>
    e.kind === 'message' && e.role === 'user' ? { ...e, parts: [...e.parts] } : e);

  while (total > maxTokens && result.length > 0) {
    const first = result[0]!;

    if (first.kind === 'message' && first.role === 'user' && first.parts.length > 0) {
      if (first.parts.length <= 1 && result.length <= 1) break;
      const dropped = (first as InputMessage).parts.shift()!;
      total -= partTokens(dropped);
      if ((first as InputMessage).parts.length === 0) result.shift();
    } else if (result.length > 1) {
      const dropped = result.shift()!;
      total -= entryTokens(dropped);
      // If dropped assistant had toolCall parts, also drop following toolResults
      if (dropped.kind === 'message' && dropped.role === 'assistant'
        && dropped.parts.some(p => p.kind === 'toolCall')) {
        while (result.length > 0 && result[0]!.kind === 'toolResult')
          total -= entryTokens(result.shift()!);
      }
    } else {
      break;
    }
  }

  // Never start with an orphaned toolResult
  while (result.length > 1 && result[0]!.kind === 'toolResult')
    total -= entryTokens(result.shift()!);

  return { entries: result, estimatedTokens: total };
};

export const composeContext = (
  rc: RenderedContext,
  trs: TurnResponseV2[],
  maxTokens: number,
  currentModelName: string,
  featureFlags?: FeatureFlags,
  compactSummary?: string,
): { entries: ConversationEntry[]; estimatedTokens: number; rawEstimatedTokens: number } | null => {
  let effectiveRC = rc;
  if (featureFlags?.trimSelfMessagesCoveredBySendToolCalls)
    effectiveRC = filterSelfSentSegments(effectiveRC);

  // Strip reasoning from TRs whose modelName does not match current model.
  // Signatures only round-trip within the same model.
  let sanitizedTRs: TurnResponseV2[] = trs.map(tr =>
    tr.modelName === currentModelName
      ? tr
      : { ...tr, entries: stripReasoning(tr.entries) });

  if (featureFlags?.trimStaleNoToolCallTurnResponses)
    sanitizedTRs = trimStaleNoToolCallTRs(sanitizedTRs);
  if (featureFlags?.trimToolResults)
    sanitizedTRs = trimToolResults(sanitizedTRs);

  const merged = mergeContext(effectiveRC, sanitizedTRs);
  if (merged.length === 0 && !compactSummary) return null;

  const entries: ConversationEntry[] = compactSummary
    ? [
        { kind: 'message', role: 'user', parts: [{ kind: 'text', text: `[Conversation summary]\n${compactSummary}` }] } satisfies InputMessage,
        ...merged,
      ]
    : merged;

  // Drop assistant messages that became empty after reasoning strip (no content,
  // no tool calls left).
  const cleaned = entries.filter(e => {
    if (e.kind !== 'message' || e.role !== 'assistant') return true;
    return e.parts.length > 0;
  });

  const rawEstimatedTokens = cleaned.reduce((a, e) => a + entryTokens(e), 0);
  const trimmed = trimEntries(cleaned, maxTokens);
  return { ...trimmed, rawEstimatedTokens };
};

export const injectLateBindingPrompt = (entries: ConversationEntry[], prompt: string): void => {
  entries.push({
    kind: 'message',
    role: 'user',
    parts: [{ kind: 'text', text: prompt }],
  } satisfies InputMessage);
};

// --- trimImages: cap total images before sending to LLM ---

const countImages = (entries: ConversationEntry[]): number => {
  let count = 0;
  for (const e of entries) {
    if (e.kind === 'toolResult' && typeof e.payload !== 'string')
      count += e.payload.filter(p => p.kind === 'image').length;
    else if (e.kind === 'message')
      for (const p of e.parts)
        if (p.kind === 'image') count++;
  }
  return count;
};

export const trimImages = (entries: ConversationEntry[], maxImages: number): ConversationEntry[] => {
  const total = countImages(entries);
  if (total <= maxImages) return entries;

  let toDrop = total - maxImages;
  return entries.map(e => {
    if (toDrop <= 0) return e;

    if (e.kind === 'message' && e.role !== 'assistant') {
      const hasImages = e.parts.some(p => p.kind === 'image');
      if (!hasImages) return e;
      const newParts: InputPart[] = [];
      for (const p of e.parts) {
        if (p.kind === 'image' && toDrop > 0) { toDrop--; continue; }
        newParts.push(p);
      }
      if (newParts.length === 0)
        newParts.push({ kind: 'text', text: '[image removed]' });
      return { ...e, parts: newParts };
    }

    if (e.kind === 'toolResult' && typeof e.payload !== 'string') {
      const hasImages = e.payload.some(p => p.kind === 'image');
      if (!hasImages) return e;
      const newParts: InputPart[] = [];
      for (const p of e.payload) {
        if (p.kind === 'image' && toDrop > 0) { toDrop--; continue; }
        newParts.push(p);
      }
      const payload: string | InputPart[] = newParts.length === 0 ? '[image removed]' : newParts;
      return { ...e, payload };
    }

    return e;
  });
};

// Re-exported for convenience to runner/compaction.
export type { ConversationEntry, InputMessage, OutputMessage, ToolCallPart, ToolResult };
