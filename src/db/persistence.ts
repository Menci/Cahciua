import { and, eq, inArray } from 'drizzle-orm';

import type { DB } from './client';
import { messages, users } from './schema';
import type { TelegramMessage, TelegramMessageDelete, TelegramMessageEdit, TelegramUser } from '../telegram/message';

export function upsertUser(db: DB, user: TelegramUser) {
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
}

export function persistMessage(db: DB, msg: TelegramMessage) {
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
}

export function persistMessageEdit(db: DB, edit: TelegramMessageEdit) {
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
}

export function persistMessageDelete(db: DB, del: TelegramMessageDelete) {
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
}
