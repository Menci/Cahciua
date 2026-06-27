import { mergeContext } from './merge';
import type { TurnResponseV2 } from './types';
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

// For the debounce: anchor the wait to the "trigger sender" — the sender of the
// oldest unprocessed external message that opened the window. Returns the latest
// message time among that sender's unprocessed messages, so only their further
// messages extend the window (others' messages don't). Returns null when there
// is no unprocessed external input.
export const triggerSenderLatestMs = (rc: RenderedContext, afterMs: number): number | null => {
  let triggerSenderId: string | undefined;
  let oldestMs: number | null = null;
  for (const seg of rc) {
    if (seg.receivedAtMs <= afterMs || seg.isMyself) continue;
    if (oldestMs == null || seg.receivedAtMs < oldestMs) {
      oldestMs = seg.receivedAtMs;
      triggerSenderId = seg.senderId;
    }
  }
  if (oldestMs == null) return null;

  let latest = oldestMs;
  for (const seg of rc) {
    if (seg.receivedAtMs <= afterMs || seg.isMyself) continue;
    if (seg.senderId === triggerSenderId && seg.receivedAtMs > latest)
      latest = seg.receivedAtMs;
  }
  return latest;
};

const trHasToolCalls = (tr: TurnResponseV2): boolean =>
  tr.entries.some(e => e.kind === 'message' && e.role === 'assistant'
    && e.parts.some(p => p.kind === 'toolCall'));

const trHasToolCallNamed = (tr: TurnResponseV2, name: string): boolean =>
  tr.entries.some(e => e.kind === 'message' && e.role === 'assistant'
    && e.parts.some(p => p.kind === 'toolCall' && p.name === name));

/** Was end_turn called in this TR? */
export const wasEndTurnCalled = (tr: TurnResponseV2): boolean =>
  trHasToolCallNamed(tr, 'end_turn');

/** Was send_message called in this TR? */
export const wasSendMessageCalled = (tr: TurnResponseV2): boolean =>
  trHasToolCallNamed(tr, 'send_message');

/** Did this TR exit via interrupt-style continuation? — i.e. at least one of
 * its toolResults had requiresFollowUp=true, meaning the runner intended to
 * keep going. Per-TR variant of `wasToolLoopInterrupted` (which only checks
 * the latest TR). */
const trWasInterrupted = (tr: TurnResponseV2): boolean => {
  for (const e of tr.entries)
    if (e.kind === 'toolResult' && e.requiresFollowUp) return true;
  return false;
};

/**
 * Determine whether the just-completed ReAct loop ended with end_turn but
 * contained no send_message anywhere — indicating the bot ran out of moves
 * without speaking. The driver uses this to schedule a fallback forced
 * send_message round.
 *
 * Loop membership is structural, not time-based: a loop is the chain of TRs
 * connected by interrupt-continuation. Walking back from the end_turn:
 *
 *  - Cross any boundary where the previous TR is interrupted (its
 *    toolResults include fwup=true) — the next TR is its resumed
 *    continuation, same loop.
 *  - Stop at the first boundary where the previous TR exited cleanly
 *    (no fwup=true toolResults) — the next TR was a fresh trigger
 *    (probe activation OR a mention/replied skip-probe), starting a new
 *    loop. Anything earlier is in a previous, separately-evaluated loop.
 *
 * Gate: the latest TR must itself be end_turn. A cycle that exited via
 * send_message (clean) or was interrupted mid-non-end-turn-step is not
 * eligible — fallback only fires for cycles the bot deliberately ended.
 *
 * Returns false if the latest TR is not end_turn, or if any TR in the
 * walked loop called send_message.
 */
export const loopEndedWithoutSendMessage = (trs: TurnResponseV2[]): boolean => {
  if (trs.length === 0) return false;
  const endIdx = trs.length - 1;
  if (!wasEndTurnCalled(trs[endIdx]!)) return false;

  for (let i = endIdx; i >= 0; i--) {
    if (wasSendMessageCalled(trs[i]!)) return false;
    if (i === 0) break;
    // The previous TR is in this loop only if it was interrupted (i.e. the
    // current TR is its continuation). Otherwise it belongs to an earlier,
    // already-completed loop and is not relevant here.
    if (!trWasInterrupted(trs[i - 1]!)) break;
  }
  return true;
};

/** Was the last TR interrupted? (ends with a requiresFollowUp ToolResult) */
export const wasToolLoopInterrupted = (trs: TurnResponseV2[]): boolean => {
  if (trs.length === 0) return false;
  const entries = trs[trs.length - 1]!.entries;
  const toolResults = entries.filter((e): e is ToolResult => e.kind === 'toolResult');
  if (toolResults.length === 0) return false;
  return toolResults.some(tr => tr.requiresFollowUp);
};

// --- trimStaleNoToolCallTurnResponses ---
const KEEP_NO_TOOL_CALL_TRS = 5;

const trimStaleNoToolCallTRs = (trs: TurnResponseV2[]): TurnResponseV2[] => {
  const noToolIndices: number[] = [];
  for (let i = 0; i < trs.length; i++)
    if (!trHasToolCalls(trs[i]!)) noToolIndices.push(i);
  if (noToolIndices.length <= KEEP_NO_TOOL_CALL_TRS) return trs;
  const dropSet = new Set(noToolIndices.slice(0, noToolIndices.length - KEEP_NO_TOOL_CALL_TRS));
  return trs.filter((_, i) => !dropSet.has(i));
};

// --- trimToolResults ---
const TOOL_RESULT_TRIM_THRESHOLD = 512;
const TOOL_RESULT_KEEP_RECENT_OVERSIZED = 5;

const trimLongText = (text: string): string => {
  if (text.length <= TOOL_RESULT_TRIM_THRESHOLD) return text;
  let prefix = text.slice(0, 200);
  // Don't split a surrogate pair — step back if the last char is a high surrogate.
  if (prefix.length > 0 && (prefix.charCodeAt(prefix.length - 1) & 0xFC00) === 0xD800)
    prefix = prefix.slice(0, -1);
  let suffix = text.slice(-200);
  // Don't start mid-surrogate — step forward if the first char is a low surrogate.
  if (suffix.length > 0 && (suffix.charCodeAt(0) & 0xFC00) === 0xDC00)
    suffix = suffix.slice(1);
  return `${prefix}\n... [trimmed ${text.length} chars] ...\n${suffix}`;
};

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

// --- trimSelfMessagesCoveredBySendToolCalls ---
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
  compactSummary?: string,
): { entries: ConversationEntry[]; estimatedTokens: number; rawEstimatedTokens: number } | null => {
  const effectiveRC = filterSelfSentSegments(rc);

  // Strip reasoning from TRs whose modelName does not match current model.
  // Signatures only round-trip within the same model.
  let sanitizedTRs: TurnResponseV2[] = trs.map(tr =>
    tr.modelName === currentModelName
      ? tr
      : { ...tr, entries: stripReasoning(tr.entries) });

  sanitizedTRs = trimStaleNoToolCallTRs(sanitizedTRs);
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

/**
 * Probe sees an outside-judge view: chat history as XML, plus a compact
 * XML rendering of past tool calls (excluding `send_message`, which is
 * already represented by the bot's own message in the chat). Each
 * toolCall/toolResult pair becomes one `<tool-call>` element, aggressively
 * truncated. The bot's `isSelfSent` segments stay (filterSelfSentSegments
 * is NOT applied) so the bot's outgoing messages show up as `<message>`.
 * Compact summary rides along for context.
 */
const PROBE_TOOL_CALL_TRUNCATE = 1024;

const truncateForProbe = (s: string): string => {
  if (s.length <= PROBE_TOOL_CALL_TRUNCATE) return s;
  const head = Math.floor(PROBE_TOOL_CALL_TRUNCATE * 0.4);
  const tail = Math.floor(PROBE_TOOL_CALL_TRUNCATE * 0.4);
  return `${s.slice(0, head)}\n... [truncated ${s.length - head - tail} chars] ...\n${s.slice(-tail)}`;
};

const formatToolResultPayload = (payload: string | InputPart[]): string => {
  if (typeof payload === 'string') return payload;
  const texts: string[] = [];
  let imageCount = 0;
  for (const p of payload) {
    if (p.kind === 'text') texts.push(p.text);
    else if (p.kind === 'image') imageCount++;
  }
  let s = texts.join('\n');
  if (imageCount > 0) s += `${s ? '\n' : ''}[${imageCount} image${imageCount > 1 ? 's' : ''} attached]`;
  return s;
};

// Wrap arbitrary text in CDATA, escaping the only sequence CDATA can't hold.
const cdata = (s: string): string =>
  `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

const xmlEscapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export const synthesizeToolCallSegments = (trs: TurnResponseV2[]): { receivedAtMs: number; content: { type: 'text'; text: string }[] }[] => {
  const segments: { receivedAtMs: number; content: { type: 'text'; text: string }[] }[] = [];
  for (const tr of trs) {
    const results = new Map<string, ToolResult>();
    for (const e of tr.entries) {
      if (e.kind === 'toolResult') results.set(e.callId, e);
    }
    for (const e of tr.entries) {
      if (e.kind !== 'message' || e.role !== 'assistant') continue;
      for (const p of e.parts) {
        if (p.kind !== 'toolCall') continue;
        // send_message is already represented as the bot's own <message> in the
        // chat XML — skip to avoid duplicate signal.
        if (p.name === 'send_message') continue;
        const result = results.get(p.callId);
        const argsTrunc = truncateForProbe(p.args);
        const resultTrunc = result ? truncateForProbe(formatToolResultPayload(result.payload)) : null;
        const t = new Date(tr.requestedAtMs).toISOString();
        const inner = resultTrunc != null
          ? `<args>${cdata(argsTrunc)}</args>\n<result>${cdata(resultTrunc)}</result>`
          : `<args>${cdata(argsTrunc)}</args>\n<result>[no result — interrupted]</result>`;
        const xml = `<tool-call name="${xmlEscapeAttr(p.name)}" t="${t}">\n${inner}\n</tool-call>`;
        segments.push({
          receivedAtMs: tr.requestedAtMs,
          content: [{ type: 'text', text: xml }],
        });
      }
    }
  }
  return segments;
};

export const composeProbeContext = (
  rc: RenderedContext,
  trs: TurnResponseV2[],
  maxTokens: number,
  compactSummary?: string,
): { entries: ConversationEntry[]; estimatedTokens: number; rawEstimatedTokens: number } | null => {
  // Synthesize tool-call XML segments and merge them with RC by timestamp.
  // No real TRs go in — mergeContext receives [] for the trs side, so the
  // probe sees only XML user-message text (no assistant entries, no tool
  // results, no reasoning).
  const synthSegments = synthesizeToolCallSegments(trs);
  const augmentedRC: RenderedContext = [...rc, ...synthSegments];
  const merged = mergeContext(augmentedRC, []);
  if (merged.length === 0 && !compactSummary) return null;

  const entries: ConversationEntry[] = compactSummary
    ? [
        { kind: 'message', role: 'user', parts: [{ kind: 'text', text: `[Conversation summary]\n${compactSummary}` }] } satisfies InputMessage,
        ...merged,
      ]
    : merged;

  const rawEstimatedTokens = entries.reduce((a, e) => a + entryTokens(e), 0);
  const trimmed = trimEntries(entries, maxTokens);
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
