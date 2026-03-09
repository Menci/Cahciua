import { and, eq, inArray } from 'drizzle-orm';

import type { DB } from './client';
import { events, messages, users } from './schema';
import type {
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalEvent,
  CanonicalMessageEvent,
} from '../adaptation/types';
import type { TelegramMessage, TelegramMessageDelete, TelegramMessageEdit, TelegramUser } from '../telegram/message';

export const upsertUser = (db: DB, user: TelegramUser) => {
  db.insert(users)
    .values({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      isBot: user.isBot,
      isPremium: user.isPremium,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        isBot: user.isBot,
        isPremium: user.isPremium,
        updatedAt: new Date(),
      },
    })
    .run();
};

export const persistMessage = (db: DB, msg: TelegramMessage) => {
  if (msg.sender) upsertUser(db, msg.sender);

  db.insert(messages)
    .values({
      chatId: msg.chatId,
      messageId: msg.messageId,
      senderId: msg.sender?.id,
      date: msg.date,
      editDate: msg.editDate,
      text: msg.text,
      entities: msg.entities,
      replyToMessageId: msg.replyToMessageId,
      replyToTopId: msg.replyToTopId,
      forwardInfo: msg.forwardInfo,
      mediaGroupId: msg.mediaGroupId,
      viaBotId: msg.viaBotId,
      attachments: msg.attachments,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [messages.chatId, messages.messageId],
      set: {
        senderId: msg.sender?.id,
        text: msg.text,
        entities: msg.entities,
        editDate: msg.editDate,
        attachments: msg.attachments,
      },
    })
    .run();
};

export const persistMessageEdit = (db: DB, edit: TelegramMessageEdit) => {
  if (edit.sender) upsertUser(db, edit.sender);

  const updated = db.update(messages)
    .set({
      text: edit.text,
      editDate: edit.editDate,
      entities: edit.entities,
      attachments: edit.attachments,
    })
    .where(and(
      eq(messages.chatId, edit.chatId),
      eq(messages.messageId, edit.messageId),
    ))
    .run();

  if (updated.changes === 0) {
    db.insert(messages)
      .values({
        chatId: edit.chatId,
        messageId: edit.messageId,
        senderId: edit.sender?.id,
        date: edit.date,
        editDate: edit.editDate,
        text: edit.text,
        entities: edit.entities,
        replyToMessageId: edit.replyToMessageId,
        attachments: edit.attachments,
        createdAt: new Date(),
      })
      .run();
  }
};

export const persistMessageDelete = (db: DB, del: TelegramMessageDelete) => {
  const now = new Date();

  if (del.chatId) {
    db.update(messages)
      .set({ deletedAt: now })
      .where(and(
        eq(messages.chatId, del.chatId),
        inArray(messages.messageId, del.messageIds),
      ))
      .run();
  } else {
    db.update(messages)
      .set({ deletedAt: now })
      .where(inArray(messages.messageId, del.messageIds))
      .run();
  }
};

export const persistEvent = (db: DB, event: CanonicalEvent) => {
  const base = {
    chatId: event.type === 'delete' ? (event.chatId ?? null) : event.chatId,
    type: event.type as 'message' | 'edit' | 'delete',
    timestamp: event.timestamp,
  };

  if (event.type === 'delete') {
    db.insert(events).values({
      ...base,
      messageIds: event.messageIds,
    }).run();
  } else {
    db.insert(events).values({
      ...base,
      messageId: event.messageId,
      senderId: event.sender?.id ?? null,
      text: event.text,
      sender: event.sender ?? null,
      entities: event.entities ?? null,
      attachments: event.attachments.length > 0 ? event.attachments : null,
      replyToMessageId: event.type === 'message' ? (event.replyToMessageId ?? null) : null,
      forwardInfo: event.type === 'message' ? (event.forwardInfo ?? null) : null,
    }).run();
  }
};

type EventRow = typeof events.$inferSelect;

const reconstructMessageEvent = (row: EventRow): CanonicalMessageEvent => {
  const event: CanonicalMessageEvent = {
    type: 'message',
    chatId: row.chatId!,
    messageId: row.messageId!,
    timestamp: row.timestamp,
    text: row.text ?? '',
    attachments: row.attachments ?? [],
  };
  if (row.sender) event.sender = row.sender;
  if (row.entities) event.entities = row.entities;
  if (row.replyToMessageId != null) event.replyToMessageId = row.replyToMessageId;
  if (row.forwardInfo) event.forwardInfo = row.forwardInfo;
  return event;
};

const reconstructEditEvent = (row: EventRow): CanonicalEditEvent => {
  const event: CanonicalEditEvent = {
    type: 'edit',
    chatId: row.chatId!,
    messageId: row.messageId!,
    timestamp: row.timestamp,
    text: row.text ?? '',
    attachments: row.attachments ?? [],
  };
  if (row.sender) event.sender = row.sender;
  if (row.entities) event.entities = row.entities;
  return event;
};

const reconstructDeleteEvent = (row: EventRow): CanonicalDeleteEvent => ({
  type: 'delete',
  chatId: row.chatId ?? undefined,
  messageIds: row.messageIds ?? [],
  timestamp: row.timestamp,
});

const reconstructEvent = (row: EventRow): CanonicalEvent => {
  switch (row.type) {
  case 'message': return reconstructMessageEvent(row);
  case 'edit': return reconstructEditEvent(row);
  case 'delete': return reconstructDeleteEvent(row);
  default: throw new Error(`Unknown event type: ${row.type}`);
  }
};

export const loadEvents = (db: DB, chatId: string): CanonicalEvent[] => {
  const rows = db.select().from(events)
    .where(eq(events.chatId, chatId))
    .orderBy(events.id)
    .all();
  return rows.map(reconstructEvent);
};
