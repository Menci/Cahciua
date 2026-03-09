import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

// Types for JSON columns

export interface MessageEntity {
  type: string; // bold, italic, url, mention, code, pre, text_link, custom_emoji, etc.
  offset: number;
  length: number;
  url?: string;
  language?: string;
  customEmojiId?: string;
  userId?: string;
}

export interface ForwardInfo {
  fromUserId?: string;
  fromChatId?: string;
  fromMessageId?: number;
  senderName?: string; // for hidden forwards
  date?: number;
}

export interface Attachment {
  type: 'photo' | 'sticker' | 'document' | 'video' | 'audio' | 'voice' | 'video_note' | 'animation';

  // Telegram file reference for re-downloading
  fileId?: string;
  fileUniqueId?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;

  // Dimensions
  width?: number;
  height?: number;
  duration?: number;

  // Low-res thumbnail base64 for LLM context (~85 tokens)
  thumbnail?: string;

  // Sticker-specific
  emoji?: string;
  stickerSetName?: string;
  isAnimatedSticker?: boolean;
  isVideoSticker?: boolean;
  customEmojiId?: string;

  // Spoiler
  hasSpoiler?: boolean;
}
