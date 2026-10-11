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
