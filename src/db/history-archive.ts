import { createHash } from 'node:crypto';

import { and, eq, gt, lte, or, sql } from 'drizzle-orm';

import type { DB } from './client';
import { codec } from './codec';
import { reconstructEvent } from './persistence';
import { compactions, events, turnResponsesV2 } from './schema';
import type { PipelineEvent } from '../projection';
import type { ConversationEntry } from '../unified-api/types';

export type HistorySource = 'events' | 'turn_responses_v2' | 'compactions';
export interface ArchiveRef {
  readonly source: HistorySource;
  readonly chatId: string;
  readonly id: number;
}
export interface ArchiveKey {
  readonly timeMs: number;
  readonly id: number;
}
// The ID fences fix source membership, including rows with backdated timestamps.
// They do not freeze mutable attachment/cache values; those require a rebuild.
export interface HistoryArchiveBounds {
  readonly chatId: string;
  readonly upperIds: Readonly<Record<HistorySource, number>>;
}
export interface ArchivePageRequest {
  readonly bounds: HistoryArchiveBounds;
  readonly after?: ArchiveKey;
  readonly limit: number;
}
export interface ArchiveValue {
  readonly ref: ArchiveRef;
  readonly key: ArchiveKey;
  readonly revision: string;
}
export interface ArchivedEvent extends ArchiveValue {
  readonly event: PipelineEvent;
}
export interface ArchivedTurn extends ArchiveValue {
  readonly entries: readonly ConversationEntry[];
  readonly modelName: string;
}
export interface ArchivedCompaction extends ArchiveValue {
  readonly summary: string;
  readonly oldCursorMs: number;
  readonly newCursorMs: number;
  readonly createdAtMs: number;
}
export interface ArchivePage<T> {
  readonly rows: readonly T[];
  readonly next?: ArchiveKey;
  readonly done: boolean;
}

const revision = (row: unknown): string => createHash('sha256').update(JSON.stringify(row)).digest('hex');
const checkLimit = (limit: number): void => {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('History page limit must be a positive safe integer');
};
const page = <T extends ArchiveValue>(rows: T[], limit: number): ArchivePage<T> => ({
  rows,
  next: rows.at(-1)?.key,
  done: rows.length < limit,
});

export const createHistoryArchive = (db: DB) => ({
  captureBounds(chatId: string): HistoryArchiveBounds {
    return db.transaction(tx => ({
      chatId,
      upperIds: {
        events: tx.select({ id: sql<number>`coalesce(max(${events.id}), 0)` }).from(events).where(eq(events.chatId, chatId)).get()!.id,
        turn_responses_v2: tx.select({ id: sql<number>`coalesce(max(${turnResponsesV2.id}), 0)` }).from(turnResponsesV2).where(eq(turnResponsesV2.chatId, chatId)).get()!.id,
        compactions: tx.select({ id: sql<number>`coalesce(max(${compactions.id}), 0)` }).from(compactions).where(eq(compactions.chatId, chatId)).get()!.id,
      },
    }));
  },
  readEvents({ bounds, after, limit }: ArchivePageRequest): ArchivePage<ArchivedEvent> {
    checkLimit(limit);
    const rows = db.select().from(events).where(and(
      eq(events.chatId, bounds.chatId), lte(events.id, bounds.upperIds.events),
      after && or(gt(events.receivedAtMs, after.timeMs), and(eq(events.receivedAtMs, after.timeMs), gt(events.id, after.id))),
    )).orderBy(events.receivedAtMs, events.id).limit(limit).all();
    return page(rows.map(row => ({
      ref: { source: 'events', chatId: row.chatId, id: row.id },
      key: { timeMs: row.receivedAtMs, id: row.id },
      revision: revision(row),
      event: reconstructEvent(row),
    })), limit);
  },
  async readTurns({ bounds, after, limit }: ArchivePageRequest): Promise<ArchivePage<ArchivedTurn>> {
    checkLimit(limit);
    const rows = db.select().from(turnResponsesV2).where(and(
      eq(turnResponsesV2.chatId, bounds.chatId), lte(turnResponsesV2.id, bounds.upperIds.turn_responses_v2),
      after && or(gt(turnResponsesV2.requestedAt, after.timeMs), and(eq(turnResponsesV2.requestedAt, after.timeMs), gt(turnResponsesV2.id, after.id))),
    )).orderBy(turnResponsesV2.requestedAt, turnResponsesV2.id).limit(limit).all();
    const decoded: ArchivedTurn[] = [];
    for (const row of rows) {
      decoded.push({
        ref: { source: 'turn_responses_v2', chatId: row.chatId, id: row.id },
        key: { timeMs: row.requestedAt, id: row.id },
        revision: revision(row),
        entries: await codec.parse(row.entries) as ConversationEntry[],
        modelName: row.modelName,
      });
    }
    return page(decoded, limit);
  },
  readCompactions({ bounds, after, limit }: ArchivePageRequest): ArchivePage<ArchivedCompaction> {
    checkLimit(limit);
    const rows = db.select().from(compactions).where(and(
      eq(compactions.chatId, bounds.chatId), lte(compactions.id, bounds.upperIds.compactions),
      after && or(gt(compactions.createdAt, after.timeMs), and(eq(compactions.createdAt, after.timeMs), gt(compactions.id, after.id))),
    )).orderBy(compactions.createdAt, compactions.id).limit(limit).all();
    return page(rows.map(row => ({
      ref: { source: 'compactions', chatId: row.chatId, id: row.id },
      key: { timeMs: row.createdAt, id: row.id },
      revision: revision(row),
      summary: row.summary,
      oldCursorMs: row.oldCursorMs,
      newCursorMs: row.newCursorMs,
      createdAtMs: row.createdAt,
    })), limit);
  },
});
export type HistoryArchive = ReturnType<typeof createHistoryArchive>;
