import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type { CanonicalAttachment, CanonicalForwardInfo, CanonicalUser, ContentNode } from '../adaptation/types';
import type { Attachment, ForwardInfo, MessageEntity } from '../telegram/message/types';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name'),
  username: text('username'),
  isBot: integer('is_bot', { mode: 'boolean' }).notNull(),
  isPremium: integer('is_premium', { mode: 'boolean' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const messages = sqliteTable('messages', {
  // Composite natural key: (chatId, messageId)
  chatId: text('chat_id').notNull(),
  messageId: integer('message_id').notNull(),

  senderId: text('sender_id').references(() => users.id),
  date: integer('date').notNull(),
  editDate: integer('edit_date'),
  text: text('text'),

  // Formatted text entities (bold, links, mentions, etc.) — stored as JSON
  entities: text('entities', { mode: 'json' }).$type<MessageEntity[]>(),

  // Reply & thread context
  replyToMessageId: integer('reply_to_message_id'),
  replyToTopId: integer('reply_to_top_id'),

  // Forward info — stored as JSON since the shape varies
  // (forwarded from user vs channel vs hidden, etc.)
  forwardInfo: text('forward_info', { mode: 'json' }).$type<ForwardInfo>(),

  // Media group (multiple photos/videos sent as album)
  mediaGroupId: text('media_group_id'),

  // Sent via inline bot
  viaBotId: text('via_bot_id'),

  // Media attachments — JSON array
  attachments: text('attachments', { mode: 'json' }).$type<Attachment[]>(),

  deletedAt: integer('deleted_at', { mode: 'timestamp' }),

  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, table => [
  uniqueIndex('messages_chat_message_idx').on(table.chatId, table.messageId),
]);

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  chatId: text('chat_id').notNull(),
  type: text('type').notNull().$type<'message' | 'edit' | 'delete'>(),
  receivedAtMs: integer('received_at').notNull(),
  timestampSec: integer('timestamp').notNull(),
  utcOffsetMin: integer('utc_offset_min').notNull().default(480),

  // message/edit only (canonical string IDs)
  messageId: text('message_id'),
  senderId: text('sender_id'),
  // Denormalized plain text for SQL search — derived from content at persist time
  text: text('text'),

  // delete only (canonical string IDs)
  messageIds: text('message_ids', { mode: 'json' }).$type<string[]>(),

  // JSON fields
  sender: text('sender', { mode: 'json' }).$type<CanonicalUser>(),
  content: text('content', { mode: 'json' }).$type<ContentNode[]>(),
  attachments: text('attachments', { mode: 'json' }).$type<CanonicalAttachment[]>(),

  // message only (canonical string ID)
  replyToMessageId: text('reply_to_message_id'),
  forwardInfo: text('forward_info', { mode: 'json' }).$type<CanonicalForwardInfo>(),
}, table => [
  index('events_chat_id_idx').on(table.chatId),
]);
