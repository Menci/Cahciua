import { createHash } from 'node:crypto';

import { and, eq, getTableColumns, lte, sql } from 'drizzle-orm';
import type { InferSelectModel, SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { DB } from './client';
import { codec } from './codec';
import { reconstructEvent } from './persistence';
import { compactions, events, turnResponsesV2 } from './schema';
import type { PipelineEvent } from '../projection';
import type { ImagePart, InputMessage, OutputMessage, TextPart, ToolResult } from '../unified-api/types';

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
  readonly maxBytes?: number;
  readonly exactId?: number;
  readonly compactionsById?: boolean;
}
export interface ArchiveValue {
  readonly ref: ArchiveRef;
  readonly key: ArchiveKey;
  readonly revision: string;
  readonly encodedBytes?: number;
}
export interface ArchivedEvent extends ArchiveValue {
  readonly event: PipelineEvent;
}
// The historical consumer needs image positions, not decoded media. It cannot
// pass this transcript view to a provider as a complete ConversationEntry[].
type ArchivedInputPart = TextPart | Pick<ImagePart, 'kind' | 'detail'>;
export type ArchivedConversationEntry = OutputMessage
  | (Omit<InputMessage, 'parts'> & { readonly parts: readonly ArchivedInputPart[] })
  | (Omit<ToolResult, 'payload'> & { readonly payload: string | readonly ArchivedInputPart[] });
export interface ArchivedTurn extends ArchiveValue {
  readonly entries: readonly ArchivedConversationEntry[];
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

export const archiveRevision = (row: unknown): string => createHash('sha256').update(JSON.stringify(row)).digest('hex');
const checkLimit = (limit: number): void => {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('History page limit must be a positive safe integer');
};
const page = <T extends ArchiveValue>(rows: T[], limit: number): ArchivePage<T> => ({
  rows,
  next: rows.at(-1)?.key,
  done: rows.length < limit,
});

// Preserve Drizzle's JSON/null codecs while using SQLite's INDEXED BY syntax.
const indexedColumns = <T extends SQLiteTable>(table: T) => Object.fromEntries(
  Object.entries(getTableColumns(table)).map(([key, column]) => [key, sql`${column}`.mapWith(column)]),
) as { [K in keyof InferSelectModel<T>]: SQL<InferSelectModel<T>[K]> };

// SQLite measures encoded rows before JSON/IR/Sharp decoding. The size query and
// fetch share a short snapshot, released before asynchronous TR decoding.
const checkBytes = (db: Pick<DB, 'select'>, table: SQLiteTable, condition: SQL | undefined, order: SQL[], indexName: string | undefined, limit: number, maxBytes?: number): number[] | undefined => {
  if (maxBytes === undefined) return undefined;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('History maxBytes must be a positive safe integer');
  const columns = Object.values(getTableColumns(table));
  const size = sql<number>`${sql.join(columns.map(column => sql`coalesce(octet_length(${column}), 0)`), sql` + `)} + 1024`;
  const sizes = db.select({ bytes: size }).from(indexName ? sql`${table} indexed by ${sql.identifier(indexName)}` : table).where(condition).orderBy(...order).limit(limit).all();
  if (sizes.reduce((total, row) => total + row.bytes, 0) > maxBytes) throw new Error(`History source exceeds encoded byte budget (${maxBytes}); cursor unchanged`);
  return sizes.map(row => row.bytes);
};

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
  readEvents({ bounds, after, limit, maxBytes, exactId }: ArchivePageRequest): ArchivePage<ArchivedEvent> {
    checkLimit(limit);
    const condition = and(
      eq(events.chatId, bounds.chatId), exactId === undefined ? undefined : eq(events.id, exactId), lte(events.id, bounds.upperIds.events),
      after && sql`(${events.receivedAtMs}, ${events.id}) > (${after.timeMs}, ${after.id})`,
    );
    const { rows, byteSizes } = db.transaction(tx => {
      const byteSizes = checkBytes(tx, events, condition, [sql`${events.receivedAtMs}`, sql`${events.id}`], undefined, limit, maxBytes);
      const rows = tx.select(indexedColumns(events)).from(events).where(condition).orderBy(events.receivedAtMs, events.id).limit(limit).all();
      return { rows, byteSizes };
    });
    return page(rows.map((row, index) => ({
      ref: { source: 'events', chatId: row.chatId, id: row.id },
      key: { timeMs: row.receivedAtMs, id: row.id },
      revision: archiveRevision(row),
      encodedBytes: byteSizes?.[index],
      event: reconstructEvent(row),
    })), limit);
  },
  async readTurns({ bounds, after, limit, maxBytes, exactId }: ArchivePageRequest): Promise<ArchivePage<ArchivedTurn>> {
    checkLimit(limit);
    const condition = and(
      eq(turnResponsesV2.chatId, bounds.chatId), exactId === undefined ? undefined : eq(turnResponsesV2.id, exactId), lte(turnResponsesV2.id, bounds.upperIds.turn_responses_v2),
      after && sql`(${turnResponsesV2.requestedAt}, ${turnResponsesV2.id}) > (${after.timeMs}, ${after.id})`,
    );
    const { rows, byteSizes } = db.transaction(tx => {
      const byteSizes = checkBytes(tx, turnResponsesV2, condition, [sql`${turnResponsesV2.requestedAt}`, sql`${turnResponsesV2.id}`], exactId === undefined ? 'turn_responses_v2_chat_requested_idx' : undefined, limit, maxBytes);
      const rows = tx.select(indexedColumns(turnResponsesV2)).from(exactId === undefined ? sql`${turnResponsesV2} indexed by ${sql.identifier('turn_responses_v2_chat_requested_idx')}` : turnResponsesV2).where(condition).orderBy(turnResponsesV2.requestedAt, turnResponsesV2.id).limit(limit).all();
      return { rows, byteSizes };
    });
    const decoded: ArchivedTurn[] = [];
    for (const [index, row] of rows.entries()) {
      decoded.push({
        ref: { source: 'turn_responses_v2', chatId: row.chatId, id: row.id },
        key: { timeMs: row.requestedAt, id: row.id },
        revision: archiveRevision(row),
        encodedBytes: byteSizes?.[index],
        entries: await codec.parse(row.entries, { omitCustomTypes: ['sharp'] }) as ArchivedConversationEntry[],
        modelName: row.modelName,
      });
    }
    return page(decoded, limit);
  },
  readCompactions({ bounds, after, limit, maxBytes, exactId, compactionsById }: ArchivePageRequest): ArchivePage<ArchivedCompaction> {
    checkLimit(limit);
    const condition = and(
      eq(compactions.chatId, bounds.chatId), exactId === undefined ? undefined : eq(compactions.id, exactId), lte(compactions.id, bounds.upperIds.compactions),
      after && (compactionsById ? sql`${compactions.id} > ${after.id}` : sql`(${compactions.createdAt}, ${compactions.id}) > (${after.timeMs}, ${after.id})`),
    );
    const { rows, byteSizes } = db.transaction(tx => {
      const byteSizes = checkBytes(tx, compactions, condition, compactionsById ? [sql`${compactions.id}`] : [sql`${compactions.createdAt}`, sql`${compactions.id}`], exactId === undefined ? 'compactions_chat_id_idx' : undefined, limit, maxBytes);
      const rows = tx.select(indexedColumns(compactions)).from(exactId === undefined ? sql`${compactions} indexed by ${sql.identifier('compactions_chat_id_idx')}` : compactions).where(condition).orderBy(...(compactionsById ? [compactions.id] : [compactions.createdAt, compactions.id])).limit(limit).all();
      return { rows, byteSizes };
    });
    return page(rows.map((row, index) => ({
      ref: { source: 'compactions', chatId: row.chatId, id: row.id },
      key: { timeMs: row.createdAt, id: row.id },
      revision: archiveRevision(row),
      encodedBytes: byteSizes?.[index],
      summary: row.summary,
      oldCursorMs: row.oldCursorMs,
      newCursorMs: row.newCursorMs,
      createdAtMs: row.createdAt,
    })), limit);
  },
});
export type HistoryArchive = ReturnType<typeof createHistoryArchive>;
