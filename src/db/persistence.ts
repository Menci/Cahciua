import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import type { DB } from './client';
import { compactions, events, messages, turnResponses, users } from './schema';
import { contentToPlainText } from '../adaptation';
import type {
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalIMEvent,
  CanonicalMessageEvent,
} from '../adaptation/types';
import type { CompactionSessionMeta, TRDataEntry } from '../driver/types';
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
  if (!del.chatId) return;

  db.update(messages)
    .set({ deletedAt: new Date() })
    .where(and(
      eq(messages.chatId, del.chatId),
      inArray(messages.messageId, del.messageIds),
    ))
    .run();
};

export const persistEvent = (db: DB, event: CanonicalIMEvent) => {
  const base = {
    chatId: event.chatId,
    type: event.type,
    receivedAtMs: event.receivedAtMs,
    timestampSec: event.timestampSec,
    utcOffsetMin: event.utcOffsetMin,
  };

  if (event.type === 'delete') {
    db.insert(events).values({
      ...base,
      messageIds: event.messageIds,
    }).run();
  } else {
    const plainText = contentToPlainText(event.content);
    db.insert(events).values({
      ...base,
      messageId: event.messageId,
      senderId: event.sender?.id ?? null,
      text: plainText || null,
      sender: event.sender ?? null,
      content: event.content.length > 0 ? event.content : null,
      attachments: event.attachments.length > 0 ? event.attachments : null,
      replyToMessageId: event.type === 'message' ? (event.replyToMessageId ?? null) : null,
      forwardInfo: event.type === 'message' ? (event.forwardInfo ?? null) : null,
      isSelfSent: event.type === 'message' ? (event.isSelfSent ?? null) : null,
    }).run();
  }
};

type EventRow = typeof events.$inferSelect;

// Load the most recent message/edit event for a given message to detect phantom edits.
export const loadLatestMessageContent = (db: DB, chatId: string, messageId: string) =>
  db.select({ text: events.text, content: events.content, attachments: events.attachments })
    .from(events)
    .where(and(
      eq(events.chatId, chatId),
      eq(events.messageId, messageId),
    ))
    .orderBy(desc(events.id))
    .limit(1)
    .get();

const reconstructMessageEvent = (row: EventRow): CanonicalMessageEvent => {
  const event: CanonicalMessageEvent = {
    type: 'message',
    chatId: row.chatId,
    messageId: row.messageId!,
    receivedAtMs: row.receivedAtMs,
    timestampSec: row.timestampSec,
    utcOffsetMin: row.utcOffsetMin,
    content: row.content ?? [],
    attachments: row.attachments ?? [],
  };
  if (row.sender) event.sender = row.sender;
  if (row.replyToMessageId != null) event.replyToMessageId = row.replyToMessageId;
  if (row.forwardInfo) event.forwardInfo = row.forwardInfo;
  if (row.isSelfSent) event.isSelfSent = true;
  return event;
};

const reconstructEditEvent = (row: EventRow): CanonicalEditEvent => {
  const event: CanonicalEditEvent = {
    type: 'edit',
    chatId: row.chatId,
    messageId: row.messageId!,
    receivedAtMs: row.receivedAtMs,
    timestampSec: row.timestampSec,
    utcOffsetMin: row.utcOffsetMin,
    content: row.content ?? [],
    attachments: row.attachments ?? [],
  };
  if (row.sender) event.sender = row.sender;
  return event;
};

const reconstructDeleteEvent = (row: EventRow): CanonicalDeleteEvent => ({
  type: 'delete',
  chatId: row.chatId,
  messageIds: row.messageIds ?? [],
  receivedAtMs: row.receivedAtMs,
  timestampSec: row.timestampSec,
  utcOffsetMin: row.utcOffsetMin,
});

const reconstructEvent = (row: EventRow): CanonicalIMEvent => {
  switch (row.type) {
  case 'message': return reconstructMessageEvent(row);
  case 'edit': return reconstructEditEvent(row);
  case 'delete': return reconstructDeleteEvent(row);
  default: throw new Error(`Unknown event type: ${row.type}`);
  }
};

export const loadEvents = (db: DB, chatId: string): CanonicalIMEvent[] => {
  const rows = db.select().from(events)
    .where(eq(events.chatId, chatId))
    .orderBy(events.receivedAtMs, events.id)
    .all();
  return rows.map(reconstructEvent);
};

// Resolve chatId for message IDs that lack chat context (MTProto private chat deletes).
// Operates on platform-level numeric IDs (messages table stores raw Telegram data).
export const lookupChatId = (db: DB, messageIds: number[]): string | undefined => {
  if (messageIds.length === 0) return undefined;
  const row = db.select({ chatId: messages.chatId })
    .from(messages)
    .where(inArray(messages.messageId, messageIds))
    .limit(1)
    .get();
  return row?.chatId;
};

export const loadKnownChatIds = (db: DB): string[] => {
  const rows = db.selectDistinct({ chatId: events.chatId })
    .from(events)
    .all();
  return rows.map(r => r.chatId);
};

export const persistTurnResponse = (db: DB, chatId: string, tr: {
  requestedAtMs: number;
  provider: string;
  data: TRDataEntry[];
  inputTokens: number;
  outputTokens: number;
  reasoningSignatureCompat?: string;
}) => {
  db.insert(turnResponses).values({
    chatId,
    requestedAt: tr.requestedAtMs,
    provider: tr.provider,
    data: tr.data,
    sessionMeta: null,
    inputTokens: tr.inputTokens,
    outputTokens: tr.outputTokens,
    reasoningSignatureCompat: tr.reasoningSignatureCompat ?? '',
  }).run();
};

export const loadTurnResponses = (db: DB, chatId: string, afterMs?: number) => {
  const query = afterMs != null
    ? db.select().from(turnResponses)
        .where(and(eq(turnResponses.chatId, chatId), gte(turnResponses.requestedAt, afterMs)))
    : db.select().from(turnResponses)
        .where(eq(turnResponses.chatId, chatId));

  return query.orderBy(turnResponses.requestedAt, turnResponses.id).all();
};

// --- Compaction storage (append-only) ---

export const persistCompaction = (db: DB, chatId: string, meta: CompactionSessionMeta) => {
  db.insert(compactions)
    .values({
      chatId,
      oldCursorMs: meta.oldCursorMs,
      newCursorMs: meta.newCursorMs,
      summary: meta.summary,
      createdAt: Date.now(),
    })
    .run();
};

export const loadCompaction = (db: DB, chatId: string): CompactionSessionMeta | null => {
  const row = db.select().from(compactions)
    .where(eq(compactions.chatId, chatId))
    .orderBy(desc(compactions.id))
    .limit(1)
    .get();
  if (!row) return null;
  return {
    oldCursorMs: row.oldCursorMs,
    newCursorMs: row.newCursorMs,
    summary: row.summary,
  };
};
