import type { ConversationEntry, MessageReasoning, ResponsesReasoningData } from './types';

export const flattenResponsesSummary = (summary: ResponsesReasoningData['summary']): string =>
  summary.map(s => s.text).join('\n');

export const messageReasoningText = (r: MessageReasoning): string | undefined =>
  [r.reasoning_content, r.reasoning, r.reasoning_text].find(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );

/** Returns a new array; does not mutate. */
export const stripReasoning = (entries: ConversationEntry[]): ConversationEntry[] =>
  entries.map(entry => {
    if (entry.kind !== 'message' || entry.role !== 'assistant') return entry;
    const hasParts = entry.parts.some(p => p.kind === 'reasoning');
    const hasData = entry.reasoning !== undefined;
    if (!hasParts && !hasData) return entry;
    return {
      ...entry,
      parts: hasParts ? entry.parts.filter(p => p.kind !== 'reasoning') : entry.parts,
      reasoning: undefined,
    };
  });
