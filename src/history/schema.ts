import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type { ArchiveKey, ArchiveRef, HistorySource } from '../db/history-archive';
import type { ICMessage, ICUserState } from '../projection';
import type { MessageSource } from './message-items';
import type { HistoryItem, HistoryNotice } from './types';

export const generations = sqliteTable('history_generations', {
  generation: text('generation').primaryKey(),
  projectionVersion: integer('projection_version').notNull(),
  // A generation cannot resume against another archive or display policy.
  archiveIdentity: text('archive_identity').notNull(),
  renderIdentity: text('render_identity').notNull(),
});
export const checkpoints = sqliteTable('history_checkpoints', {
  generation: text('generation').notNull(),
  chatId: text('chat_id').notNull(),
  source: text('source_kind').notNull().$type<HistorySource>(),
  upperId: integer('upper_id').notNull(),
  after: text('after_json', { mode: 'json' }).$type<ArchiveKey>(),
  scanComplete: integer('scan_complete', { mode: 'boolean' }).notNull().default(false),
}, t => [primaryKey({ columns: [t.generation, t.chatId, t.source] })]);
export const savedItems = sqliteTable('history_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  generation: text('generation').notNull(),
  chatId: text('chat_id').notNull(),
  key: text('item_key').notNull(),
  kind: text('kind').notNull().$type<HistoryItem['kind']>(),
  timeMs: integer('time_ms').notNull(),
  sourceOrder: integer('source_order').notNull(),
  sourceId: integer('source_id').notNull(),
  entryIndex: integer('entry_index').notNull(),
  partIndex: integer('part_index').notNull(),
  item: text('item_json', { mode: 'json' }).notNull().$type<HistoryItem>(),
  searchText: text('search_text').notNull(),
}, t => [
  uniqueIndex('history_items_key').on(t.generation, t.chatId, t.key),
  index('history_items_timeline').on(t.generation, t.chatId, t.timeMs, t.sourceOrder, t.sourceId, t.entryIndex, t.partIndex),
]);
export const relations = sqliteTable('history_relations', {
  generation: text('generation').notNull(),
  chatId: text('chat_id').notNull(),
  fromKey: text('from_key').notNull(),
  toKey: text('to_key').notNull(),
  kind: text('kind').notNull(),
}, t => [primaryKey({ columns: [t.generation, t.chatId, t.fromKey, t.toKey, t.kind] })]);
export const messageStates = sqliteTable('history_message_states', {
  generation: text('generation').notNull(),
  chatId: text('chat_id').notNull(),
  messageId: text('message_id').notNull(),
  state: text('state_json', { mode: 'json' }).notNull().$type<{ node: ICMessage; source: MessageSource }>(),
}, t => [primaryKey({ columns: [t.generation, t.chatId, t.messageId] })]);
export const userStates = sqliteTable('history_user_states', {
  generation: text('generation').notNull(),
  chatId: text('chat_id').notNull(),
  userId: text('user_id').notNull(),
  state: text('state_json', { mode: 'json' }).notNull().$type<ICUserState>(),
}, t => [primaryKey({ columns: [t.generation, t.chatId, t.userId] })]);
export const chatStates = sqliteTable('history_chat_states', {
  generation: text('generation').notNull(),
  chatId: text('chat_id').notNull(),
  title: text('title'),
}, t => [primaryKey({ columns: [t.generation, t.chatId] })]);
export const messageRevisions = sqliteTable('history_message_revisions', {
  generation: text('generation').notNull(),
  chatId: text('chat_id').notNull(),
  messageId: text('message_id').notNull(),
  eventId: integer('event_id').notNull(),
  source: text('source_json', { mode: 'json' }).notNull().$type<ArchiveRef>(),
  archiveRevision: text('archive_revision').notNull(),
  parentRevision: text('parent_revision'),
  revision: text('revision').notNull(),
}, t => [primaryKey({ columns: [t.generation, t.chatId, t.messageId, t.eventId] })]);
export const taskStarts = sqliteTable('history_task_starts', {
  generation: text('generation').notNull(),
  chatId: text('chat_id').notNull(),
  taskId: integer('task_id').notNull(),
  toolKey: text('tool_key').notNull(),
}, t => [primaryKey({ columns: [t.generation, t.chatId, t.taskId, t.toolKey] })]);
export const notices = sqliteTable('history_notices', {
  generation: text('generation').notNull(),
  chatId: text('chat_id').notNull(),
  eventId: integer('event_id').notNull(),
  notice: text('notice_json', { mode: 'json' }).notNull().$type<HistoryNotice>(),
}, t => [primaryKey({ columns: [t.generation, t.chatId, t.eventId] })]);

export const consumers = sqliteTable('history_consumers', {
  generation: text('generation').primaryKey(),
  baselineSeq: integer('baseline_seq').notNull(),
  reconcileSeq: integer('reconcile_seq'),
  consumeSeq: integer('consume_seq').notNull(),
  pendingSeq: integer('pending_seq'),
  baselineComplete: integer('baseline_complete', { mode: 'boolean' }).notNull().default(false),
  status: text('status_json', { mode: 'json' }).$type<Record<string, unknown>>(),
});
export const consumeTasks = sqliteTable('history_consume_tasks', {
  generation: text('generation').notNull(),
  taskKey: text('task_key').notNull(),
  chatId: text('chat_id').notNull(),
  kind: text('kind').notNull().$type<'message' | 'events' | 'turn_responses_v2' | 'compactions' | 'cache' | 'replies' | 'completion'>(),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
  sourceKey: text('source_key').notNull(),
}, t => [primaryKey({ columns: [t.generation, t.taskKey] }), index('history_tasks_pending_idx').on(t.generation, t.done, t.taskKey)]);
export const mediaDependencies = sqliteTable('history_media_dependencies', {
  generation: text('generation').notNull(),
  chatId: text('chat_id').notNull(),
  messageId: text('message_id').notNull(),
  cacheKey: text('cache_key').notNull(),
}, t => [
  primaryKey({ columns: [t.generation, t.chatId, t.messageId, t.cacheKey] }),
  index('history_media_cache_idx').on(t.generation, t.cacheKey, t.chatId, t.messageId),
]);

// Synchronization belongs exclusively to the rebuildable history database.
export const sourceObservations = sqliteTable('history_source_observations', {
  generation: text('generation').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceKey: text('source_key').notNull(),
  sourceId: integer('source_id'),
  chatId: text('chat_id'),
  revision: text('revision').notNull(),
  observation: text('observation_json').notNull(),
  messageId: text('message_id'),
  replyToMessageId: text('reply_to_message_id'),
  taskId: integer('task_id'),
  timeMs: integer('time_ms').notNull(),
}, t => [
  primaryKey({ columns: [t.generation, t.sourceKind, t.sourceKey] }),
  index('history_observed_time_idx').on(t.generation, t.sourceKind, t.chatId, t.timeMs, t.sourceId),
  index('history_observed_id_idx').on(t.generation, t.sourceKind, t.chatId, t.sourceId),
  index('history_observed_replies_idx').on(t.generation, t.chatId, t.replyToMessageId, t.timeMs, t.sourceId),
  index('history_observed_tasks_idx').on(t.generation, t.chatId, t.taskId, t.timeMs, t.sourceId),
]);
export const sourceChanges = sqliteTable('history_source_changes', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  generation: text('generation').notNull(),
  change: text('change_json').notNull(),
}, t => [index('history_observed_changes_idx').on(t.generation, t.seq)]);
export const sourceScans = sqliteTable('history_source_scans', {
  generation: text('generation').primaryKey(),
  state: text('state_json').notNull(),
});
export const eventTargets = sqliteTable('history_event_targets', {
  generation: text('generation').notNull(),
  chatId: text('chat_id').notNull(),
  messageId: text('message_id').notNull(),
  eventId: integer('event_id').notNull(),
  receivedAt: integer('received_at').notNull(),
}, t => [
  primaryKey({ columns: [t.generation, t.chatId, t.messageId, t.receivedAt, t.eventId] }),
  index('history_observed_event_idx').on(t.generation, t.eventId),
]);

export const pendingMedia = sqliteTable('history_pending_media', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  generation: text('generation').notNull(),
  sourceKind: text('source_kind').notNull().$type<'events' | 'image_alt_texts'>(),
  sourceKey: text('source_key').notNull(),
  chatId: text('chat_id'),
  scheduledSeq: integer('scheduled_seq'),
}, t => [
  uniqueIndex('history_pending_media_key').on(t.generation, t.sourceKind, t.sourceKey),
  index('history_pending_media_recovery_idx').on(t.generation, t.id),
]);

export const buildInputs = sqliteTable('history_build_inputs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  generation: text('generation').notNull(),
  sourceKind: text('source_kind').notNull().$type<'events' | 'image_alt_texts' | 'pending'>(),
  sourceKey: text('source_key').notNull(),
  afterId: integer('after_id').notNull().default(0),
  upperId: integer('upper_id'),
}, t => [
  uniqueIndex('history_build_inputs_key').on(t.generation, t.sourceKind, t.sourceKey),
  index('history_build_inputs_order').on(t.generation, t.id),
]);
