import type { HistoryResult, HistoryTool } from './types';

export const startedTaskId = (tool: HistoryTool, result: HistoryResult): number | undefined => {
  // Only the explicit start identity in the bash result establishes this edge.
  if (tool.name !== 'bash' || result.pairing !== 'matched' || typeof result.payload !== 'string') return undefined;
  let payload: unknown;
  try { payload = JSON.parse(result.payload); } catch { return undefined; }
  if (typeof payload !== 'object' || payload === null || !('background_task_id' in payload)) return undefined;
  const id = payload.background_task_id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined;
};
