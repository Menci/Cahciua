import type { HistoryItem, HistoryOrder, HistoryOutput, HistoryPosition, HistoryResult, HistoryText, HistoryTool } from './types';
import type { ArchivedTurn } from '../db/history-archive';

export const historyKey = (chatId: string, ...parts: (string | number)[]): string =>
  JSON.stringify([chatId, ...parts]);

export const compareHistoryOrder = (a: HistoryOrder, b: HistoryOrder): number =>
  a.timeMs - b.timeMs || a.sourceOrder - b.sourceOrder || a.sourceId - b.sourceId
  || a.entryIndex - b.entryIndex || a.partIndex - b.partIndex;

// Associations are scoped to one archived TR. Duplicate call IDs within that
// TR remain ambiguous rather than choosing a candidate by position or time.
export const buildTurnItems = (turn: ArchivedTurn): HistoryItem[] => {
  const items: HistoryItem[] = [];
  const tools = new Map<string, HistoryTool[]>();
  const results = new Map<string, HistoryResult[]>();
  const base = (entryIndex: number, partIndex = -1) => ({
    chatId: turn.ref.chatId,
    source: turn.ref,
    sourceRevision: turn.revision,
    order: { timeMs: turn.key.timeMs, sourceOrder: 1 as const, sourceId: turn.ref.id, entryIndex, partIndex },
  });
  const key = (entryIndex: number, partIndex = -1) => historyKey(turn.ref.chatId, 'turn', turn.ref.id, entryIndex, partIndex);
  for (const [entryIndex, entry] of turn.entries.entries()) {
    if (entry.kind === 'toolResult') {
      const result: HistoryResult = {
        ...base(entryIndex), key: key(entryIndex), kind: 'tool-result', entryIndex,
        callId: entry.callId, requiresFollowUp: entry.requiresFollowUp, pairing: 'missing',
        payload: typeof entry.payload === 'string' ? entry.payload : entry.payload.map((part, partIndex) => {
          const position: HistoryPosition = { entryIndex, partIndex };
          return part.kind === 'text' ? { kind: 'text', text: part.text, position } : { kind: 'image', position };
        }),
      };
      results.set(entry.callId, [...(results.get(entry.callId) ?? []), result]);
      items.push(result);
      continue;
    }
    if (entry.role !== 'assistant') continue;
    const parts: HistoryText[] = [];
    const toolKeys: string[] = [];
    for (const [partIndex, part] of entry.parts.entries()) {
      const position = { entryIndex, partIndex };
      if (part.kind === 'text') parts.push({ kind: 'text', text: part.text, position });
      if (part.kind === 'textGroup') {
        for (const [textIndex, text] of part.content.entries())
          parts.push({ kind: 'text', text: text.text, position: { ...position, textIndex } });
      }
      if (part.kind === 'toolCall') {
        const tool: HistoryTool = {
          ...base(entryIndex, partIndex), key: key(entryIndex, partIndex), kind: 'tool-execution',
          position, outputKey: key(entryIndex), callId: part.callId, name: part.name, args: part.args,
          resultKeys: [], pairing: 'missing',
        };
        toolKeys.push(tool.key);
        tools.set(part.callId, [...(tools.get(part.callId) ?? []), tool]);
        items.push(tool);
      }
    }
    // Keep outputs containing only tools; reasoning-only outputs expose no data.
    const output: HistoryOutput = {
      ...base(entryIndex), key: key(entryIndex), kind: 'model-output', entryIndex,
      modelName: turn.modelName, parts, toolKeys,
    };
    if (parts.length > 0 || toolKeys.length > 0) items.push(output);
  }
  return items.map((item): HistoryItem => {
    if (item.kind !== 'tool-result' && item.kind !== 'tool-execution') return item;
    const calls = tools.get(item.callId) ?? [];
    const matches = results.get(item.callId) ?? [];
    const pairing: HistoryTool['pairing'] = calls.length > 1 || matches.length > 1 ? 'ambiguous' : calls.length === 1 && matches.length === 1 ? 'matched' : 'missing';
    return item.kind === 'tool-execution'
      ? { ...item, pairing, resultKeys: pairing === 'matched' ? matches.map(r => r.key) : [] }
      : { ...item, pairing, toolKey: pairing === 'matched' ? calls[0]!.key : undefined, outputKey: pairing === 'matched' ? calls[0]!.outputKey : undefined };
  }).sort((a, b) => compareHistoryOrder(a.order, b.order));
};
