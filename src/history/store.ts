import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import type { ArchivedEvent, HistoryArchiveBounds, HistorySource } from '../db/history-archive';
import type { ICMessage, ICUserState } from '../projection';
import type { WorkspaceBudget } from './budget';
import type { MessageSource } from './message-items';
import * as schema from './schema';
import { startedTaskId } from './task-items';
import { historyKey } from './turn-items';
import type { HistoryBatch, HistoryItem, HistoryTool } from './types';

export const HISTORY_PROJECTION_VERSION = 1;
export interface HistoryCheckpoint {
  readonly bounds: HistoryArchiveBounds;
  readonly source: HistorySource;
  readonly after?: { readonly timeMs: number; readonly id: number };
  readonly done: boolean;
}
export interface HistoryCommit {
  readonly generation: string;
  readonly expected: HistoryCheckpoint;
  readonly batch: HistoryBatch;
  readonly messages?: readonly { node: ICMessage; source: MessageSource; parentRevision?: string }[];
  readonly users?: readonly { id: string; state: ICUserState }[];
  readonly chatTitle?: string;
  readonly event?: ArchivedEvent;
}

export const searchableText = (item: HistoryItem): string => {
  switch (item.kind) {
  case 'message': return [item.transcript.text, item.transcript.reply?.text].filter(Boolean).join('\n');
  case 'model-output': return item.parts.map(part => part.text).join('\n');
  case 'tool-execution': return [item.name, item.args, item.completion?.finalSummary].filter(Boolean).join('\n');
  case 'tool-result': return typeof item.payload === 'string' ? item.payload : item.payload.filter(part => part.kind === 'text').map(part => part.text).join('\n');
  case 'summary': return item.summary;
  }
};
const itemRelations = (item: HistoryItem): { toKey: string; kind: string }[] => {
  switch (item.kind) {
  case 'message': return item.metadata.replyTo ? [{ toKey: historyKey(item.chatId, 'message', item.metadata.replyTo.messageId), kind: 'reply' }] : [];
  case 'model-output': return item.toolKeys.map(toKey => ({ toKey, kind: 'tool-member' }));
  case 'tool-execution': return [{ toKey: item.outputKey, kind: 'output' }, ...item.resultKeys.map(toKey => ({ toKey, kind: 'result' }))];
  case 'tool-result': return item.toolKey ? [{ toKey: item.toolKey, kind: 'call' }] : [];
  case 'summary': return [];
  }
};

export const openHistoryStore = (path: string, migrationsFolder = resolve(import.meta.dirname, '../../history-drizzle')) => {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  try {
    if (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('events', 'turn_responses_v2', 'compactions') LIMIT 1").get()) throw new Error('Refusing to migrate an archive as history.db');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('busy_timeout = 5000');
    // Bound SQLite page cache separately from the JS dependency workspace.
    sqlite.pragma('cache_size = -2048');
    sqlite.pragma('temp_store = FILE');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });
    const scope = (generation: string, chatId: string) => and(eq(schema.savedItems.generation, generation), eq(schema.savedItems.chatId, chatId));
    const checkpointRows = (generation: string, chatId: string) => db.select().from(schema.checkpoints)
      .where(and(eq(schema.checkpoints.generation, generation), eq(schema.checkpoints.chatId, chatId))).all();
    const checkpoint = (generation: string, chatId: string, source: HistorySource): HistoryCheckpoint => {
      const rows = checkpointRows(generation, chatId);
      const current = rows.find(row => row.source === source);
      if (!current || rows.length !== 3) throw new Error('Missing historical bootstrap checkpoints');
      const upperIds = { events: 0, turn_responses_v2: 0, compactions: 0 };
      for (const row of rows) upperIds[row.source] = row.upperId;
      return { bounds: { chatId, upperIds }, source, after: current.after ?? undefined, done: current.scanComplete };
    };
    return {
      db,
      sqlite,
      close: () => sqlite.close(),
      initialize(generation: string, archiveIdentity: string, renderIdentity: string, chatId: string, captureBounds: () => HistoryArchiveBounds): void {
        db.transaction(tx => {
          const existing = tx.select().from(schema.generations).where(eq(schema.generations.generation, generation)).get();
          if (existing && (existing.projectionVersion !== HISTORY_PROJECTION_VERSION || existing.archiveIdentity !== archiveIdentity || existing.renderIdentity !== renderIdentity)) {
            throw new Error('History generation identity/version mismatch; create a new generation');
          }
          tx.insert(schema.generations).values({ generation, archiveIdentity, renderIdentity, projectionVersion: HISTORY_PROJECTION_VERSION }).onConflictDoNothing().run();
          const rows = checkpointRows(generation, chatId);
          if (rows.length === 3) return;
          if (rows.length !== 0) throw new Error('Incomplete historical fence capture');
          const bounds = captureBounds();
          if (bounds.chatId !== chatId) throw new Error('Historical fence scope mismatch');
          for (const source of ['events', 'turn_responses_v2', 'compactions'] as const) {
            tx.insert(schema.checkpoints).values({ generation, chatId: bounds.chatId, source, upperId: bounds.upperIds[source] }).onConflictDoNothing().run();
          }
        });
      },
      checkpoint,
      loadMessage(generation: string, chatId: string, messageId: string, budget: WorkspaceBudget) {
        budget.entry();
        const where = and(eq(schema.messageStates.generation, generation), eq(schema.messageStates.chatId, chatId), eq(schema.messageStates.messageId, messageId));
        return db.transaction(tx => {
          const size = tx.select({ bytes: sql<number>`octet_length(${schema.messageStates.state})` }).from(schema.messageStates).where(where).get();
          if (!size) return undefined;
          budget.reserve(size.bytes);
          return tx.select({ state: schema.messageStates.state }).from(schema.messageStates).where(where).get()!.state;
        });
      },
      loadUser(generation: string, chatId: string, userId: string, budget: WorkspaceBudget) {
        budget.entry();
        const where = and(eq(schema.userStates.generation, generation), eq(schema.userStates.chatId, chatId), eq(schema.userStates.userId, userId));
        return db.transaction(tx => {
          const size = tx.select({ bytes: sql<number>`octet_length(${schema.userStates.state})` }).from(schema.userStates).where(where).get();
          if (!size) return undefined;
          budget.reserve(size.bytes);
          return tx.select({ state: schema.userStates.state }).from(schema.userStates).where(where).get()!.state;
        });
      },
      loadChatTitle(generation: string, chatId: string, budget: WorkspaceBudget): string | undefined {
        const where = and(eq(schema.chatStates.generation, generation), eq(schema.chatStates.chatId, chatId));
        return db.transaction(tx => {
          const size = tx.select({ bytes: sql<number>`coalesce(octet_length(${schema.chatStates.title}), 0)` }).from(schema.chatStates).where(where).get();
          if (!size) return undefined;
          budget.reserve(size.bytes);
          return tx.select({ title: schema.chatStates.title }).from(schema.chatStates).where(where).get()!.title ?? undefined;
        });
      },
      loadTask(generation: string, chatId: string, taskId: number, budget: WorkspaceBudget): { count: number; tool?: HistoryTool } {
        // Two identities suffice to detect ambiguity. Never decode all starts.
        const candidates = db.select({ key: schema.taskStarts.toolKey }).from(schema.taskStarts).where(and(
          eq(schema.taskStarts.generation, generation), eq(schema.taskStarts.chatId, chatId), eq(schema.taskStarts.taskId, taskId),
        )).limit(2).all();
        if (candidates.length !== 1) return { count: candidates.length };
        budget.entry();
        const where = and(scope(generation, chatId), eq(schema.savedItems.key, candidates[0]!.key));
        return db.transaction(tx => {
          const size = tx.select({ bytes: sql<number>`octet_length(${schema.savedItems.item})` }).from(schema.savedItems).where(where).get();
          if (!size) throw new Error('Missing persisted background task tool');
          budget.reserve(size.bytes);
          const item = tx.select({ item: schema.savedItems.item }).from(schema.savedItems).where(where).get()!.item;
          if (item.kind !== 'tool-execution') throw new Error('Background task identity points to a non-tool');
          return { count: 1, tool: item };
        });
      },
      commit(plan: HistoryCommit): 'committed' | 'duplicate' {
        return db.transaction(tx => {
          const { generation, expected, batch } = plan;
          const { bounds, source } = expected;
          const current = checkpoint(generation, bounds.chatId, source);
          // CAS avoids two builders applying stale state. Repeated committed
          // plans are idempotent, including source-revision chain updates.
          if (JSON.stringify(current) === JSON.stringify(batch.progress)) return 'duplicate';
          if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Stale historical checkpoint');
          if (batch.progress.source !== source || JSON.stringify(batch.progress.bounds) !== JSON.stringify(bounds)) throw new Error('Historical commit scope mismatch');
          for (const { item } of batch.changes) {
            if (item.chatId !== bounds.chatId || item.source.chatId !== bounds.chatId) throw new Error('Historical item scope mismatch');
            tx.insert(schema.savedItems).values({
              generation, chatId: item.chatId, key: item.key, kind: item.kind,
              timeMs: item.order.timeMs, sourceOrder: item.order.sourceOrder, sourceId: item.order.sourceId,
              entryIndex: item.order.entryIndex, partIndex: item.order.partIndex, item, searchText: searchableText(item),
            }).onConflictDoUpdate({
              target: [schema.savedItems.generation, schema.savedItems.chatId, schema.savedItems.key],
              set: { item, searchText: searchableText(item) },
            }).run();
            tx.delete(schema.relations).where(and(eq(schema.relations.generation, generation), eq(schema.relations.chatId, item.chatId), eq(schema.relations.fromKey, item.key))).run();
            for (const relation of itemRelations(item)) tx.insert(schema.relations).values({ generation, chatId: item.chatId, fromKey: item.key, ...relation }).onConflictDoNothing().run();
          }
          const tools = new Map(batch.changes.map(change => change.item).filter((item): item is HistoryTool => item.kind === 'tool-execution').map(item => [item.key, item]));
          for (const { item } of batch.changes) {
            if (item.kind !== 'tool-result' || !item.toolKey) continue;
            const tool = tools.get(item.toolKey);
            if (!tool) throw new Error('Missing historical tool start');
            const taskId = startedTaskId(tool, item);
            if (taskId !== undefined) tx.insert(schema.taskStarts).values({ generation, chatId: bounds.chatId, taskId, toolKey: tool.key }).onConflictDoNothing().run();
          }
          for (const state of plan.messages ?? []) {
            tx.insert(schema.messageStates).values({ generation, chatId: bounds.chatId, messageId: state.node.messageId, state })
              .onConflictDoUpdate({ target: [schema.messageStates.generation, schema.messageStates.chatId, schema.messageStates.messageId], set: { state } }).run();
            if (!plan.event) throw new Error('Missing historical state revision source');
            tx.insert(schema.messageRevisions).values({
              generation, chatId: bounds.chatId, messageId: state.node.messageId, eventId: plan.event.ref.id,
              source: plan.event.ref, archiveRevision: plan.event.revision, parentRevision: state.parentRevision, revision: state.source.revision,
            }).onConflictDoNothing().run();
          }
          for (const user of plan.users ?? []) tx.insert(schema.userStates).values({ generation, chatId: bounds.chatId, userId: user.id, state: user.state })
            .onConflictDoUpdate({ target: [schema.userStates.generation, schema.userStates.chatId, schema.userStates.userId], set: { state: user.state } }).run();
          if (plan.event) tx.insert(schema.chatStates).values({ generation, chatId: bounds.chatId, title: plan.chatTitle })
            .onConflictDoUpdate({ target: [schema.chatStates.generation, schema.chatStates.chatId], set: { title: plan.chatTitle ?? null } }).run();
          for (const notice of batch.notices) tx.insert(schema.notices).values({ generation, chatId: bounds.chatId, eventId: notice.source.id, notice }).onConflictDoNothing().run();
          tx.update(schema.checkpoints).set({ after: batch.progress.after ?? null, scanComplete: batch.progress.done })
            .where(and(eq(schema.checkpoints.generation, generation), eq(schema.checkpoints.chatId, bounds.chatId), eq(schema.checkpoints.source, source))).run();
          return 'committed';
        });
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
};
export type HistoryStore = ReturnType<typeof openHistoryStore>;
