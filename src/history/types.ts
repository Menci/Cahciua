import type { ArchiveKey, ArchiveRef, HistoryArchiveBounds, HistorySource } from '../db/history-archive';
import type { RenderedMessageMetadata } from '../rendering/types';

export interface HistoryPosition {
  readonly entryIndex: number;
  readonly partIndex: number;
  readonly textIndex?: number;
}
export interface HistoryOrder {
  readonly timeMs: number;
  readonly sourceOrder: 0 | 1 | 2;
  readonly sourceId: number;
  readonly entryIndex: number;
  readonly partIndex: number;
}
export interface HistoryBase {
  readonly key: string;
  readonly chatId: string;
  readonly order: HistoryOrder;
  readonly source: ArchiveRef;
  readonly sourceRevision: string;
}
export interface HistoryMessage extends HistoryBase {
  readonly kind: 'message';
  readonly changedBy: ArchiveRef;
  readonly metadata: RenderedMessageMetadata;
  readonly transcript: { readonly text: string; readonly xml: string; readonly reply?: { readonly text: string; readonly xml: string } };
}
export interface HistoryText {
  readonly kind: 'text';
  readonly text: string;
  readonly position: HistoryPosition;
}
export interface HistoryImage {
  readonly kind: 'image';
  readonly position: HistoryPosition;
  // Bytes remain in the original TR; this locator permits future expansion.
}
export interface HistoryOutput extends HistoryBase {
  readonly kind: 'model-output';
  readonly entryIndex: number;
  readonly modelName: string;
  readonly parts: readonly HistoryText[];
  readonly toolKeys: readonly string[];
}
export interface HistoryTool extends HistoryBase {
  readonly kind: 'tool-execution';
  readonly position: HistoryPosition;
  readonly outputKey: string;
  readonly callId: string;
  readonly name: string;
  readonly args: string;
  readonly resultKeys: readonly string[];
  readonly pairing: 'matched' | 'missing' | 'ambiguous';
  readonly completion?: {
    readonly source: ArchiveRef;
    readonly sourceRevision: string;
    readonly taskId: number;
    readonly taskType: string;
    readonly finalSummary: string;
    readonly hasFullOutput: boolean;
  };
}
export interface HistoryResult extends HistoryBase {
  readonly kind: 'tool-result';
  readonly entryIndex: number;
  readonly callId: string;
  readonly payload: string | readonly (HistoryText | HistoryImage)[];
  readonly requiresFollowUp: boolean;
  readonly toolKey?: string;
  readonly outputKey?: string;
  readonly pairing: 'matched' | 'missing' | 'ambiguous';
}
export interface HistorySummary extends HistoryBase {
  readonly kind: 'summary';
  readonly summary: string;
  readonly compactionId: number;
  readonly createdAtMs: number;
  readonly coverage: { readonly fromReceivedAtMs: number; readonly untilReceivedAtMs: number };
}
export type HistoryItem = HistoryMessage | HistoryOutput | HistoryTool | HistoryResult | HistorySummary;
export interface HistoryChange {
  readonly operation: 'upsert';
  readonly item: HistoryItem;
}
export interface HistoryNotice {
  readonly kind: 'unlinked-task-completion' | 'ambiguous-task-completion';
  readonly source: ArchiveRef;
  readonly taskId: number;
}
export interface HistoryBatch {
  readonly changes: readonly HistoryChange[];
  readonly notices: readonly HistoryNotice[];
  // Reading progress is per chat/source, independent of the rendering range.
  readonly progress: {
    readonly bounds: HistoryArchiveBounds;
    readonly source: HistorySource;
    readonly after?: ArchiveKey;
    readonly done: boolean;
  };
}
