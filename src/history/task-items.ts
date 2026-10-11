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

export const sentMessageId = (tool: HistoryTool, result: HistoryResult): string | undefined => {
  if (tool.name !== 'send_message' || result.pairing !== 'matched' || typeof result.payload !== 'string') return undefined;
  let payload: unknown;
  try { payload = JSON.parse(result.payload); } catch { return undefined; }
  if (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true || !('message_id' in payload)) return undefined;
  const id = payload.message_id;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id);
  return typeof id === 'string' && /^[1-9]\d*$/.test(id) ? id : undefined;
};
