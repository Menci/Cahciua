export interface RuntimeTaskCompletedEvent {
  type: 'runtime';
  kind: 'task_completed';
  chatId: string;
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  taskId: number;
  taskType: string;
  intention?: string;
  finalSummary: string;
  hasFullOutput: boolean;
}

// Extensible: future runtime event kinds can be added here.
export type RuntimeEvent = RuntimeTaskCompletedEvent;

// Stored in the events table's runtimeData JSON column.
export interface RuntimeTaskCompletedData {
  kind: 'task_completed';
  taskId: number;
  taskType: string;
  intention?: string;
  finalSummary: string;
  hasFullOutput: boolean;
}

export type RuntimeEventData = RuntimeTaskCompletedData;
