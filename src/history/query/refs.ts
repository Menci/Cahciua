import type { HistoryItem } from '../types';

export const itemRef = (item: HistoryItem): string => {
  switch (item.kind) {
  case 'message': return `message:${item.metadata.messageId}`;
  case 'model-output': return `output:${item.source.id}/entry:${item.entryIndex}`;
  case 'tool-execution': return `call:${item.source.id}/entry:${item.position.entryIndex}/part:${item.position.partIndex}`;
  case 'tool-result': return `result:${item.source.id}/entry:${item.entryIndex}`;
  case 'summary': return `summary:${item.compactionId}`;
  }
};
export const keyRef = (key: string, kind: HistoryItem['kind']): string => {
  const parts = JSON.parse(key) as (string | number)[];
  if (kind === 'message') return `message:${parts[2]}`;
  if (kind === 'summary') return `summary:${parts[2]}`;
  const prefix = kind === 'model-output' ? 'output' : kind === 'tool-result' ? 'result' : 'call';
  return `${prefix}:${parts[2]}/entry:${parts[3]}${prefix === 'call' ? `/part:${parts[4]}` : ''}`;
};
export const publicKind = (kind: HistoryItem['kind']): string => ({ message: 'message', 'model-output': 'assistant_text', 'tool-execution': 'tool_call', 'tool-result': 'tool_result', summary: 'summary' })[kind];
