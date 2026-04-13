import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

import type { DB } from './client';
import { backgroundTasks, compactions, events, imageAltTexts, messages, probeResponses, turnResponses, users } from './schema';
import { contentToPlainText } from '../adaptation';
import type {
  CanonicalAttachment,
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalMessageEvent,
  CanonicalServiceEvent,
} from '../adaptation/types';
import type { CompactionSessionMeta, ResponsesTRDataItem, TRDataEntry, TurnResponse } from '../driver/types';
import type { PipelineEvent } from '../projection/reduce';
import type { RuntimeEvent, RuntimeEventData } from '../runtime-event';
import type { ImageAltTextRecord } from '../telegram/image-to-text';
import type { TelegramMessage, TelegramMessageDelete, TelegramMessageEdit, TelegramUser } from '../telegram/message';
import type { Attachment } from '../telegram/message/types';

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
        // Converge fields that may arrive from different sources (bot vs userbot).
        // COALESCE(new, existing) ensures a non-null value is never overwritten by null.
        replyToMessageId: sql`coalesce(${msg.replyToMessageId ?? null}, ${messages.replyToMessageId})`,
        replyToTopId: sql`coalesce(${msg.replyToTopId ?? null}, ${messages.replyToTopId})`,
        forwardInfo: sql`coalesce(${msg.forwardInfo ? JSON.stringify(msg.forwardInfo) : null}, ${messages.forwardInfo})`,
        mediaGroupId: sql`coalesce(${msg.mediaGroupId ?? null}, ${messages.mediaGroupId})`,
        viaBotId: sql`coalesce(${msg.viaBotId ?? null}, ${messages.viaBotId})`,
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

export const persistEvent = (db: DB, event: PipelineEvent) => {
  const base = {
    chatId: event.chatId,
    type: event.type,
    receivedAtMs: event.receivedAtMs,
    timestampSec: event.timestampSec,
    utcOffsetMin: event.utcOffsetMin,
  };

  if (event.type === 'runtime') {
    const runtimeData: RuntimeEventData = {
      kind: event.kind,
      taskId: event.taskId,
      taskType: event.taskType,
      intention: event.intention,
      finalSummary: event.finalSummary,
      hasFullOutput: event.hasFullOutput,
    };
    db.insert(events).values({ ...base, runtimeData }).run();
  } else if (event.type === 'delete') {
    db.insert(events).values({
      ...base,
      messageIds: event.messageIds,
    }).run();
  } else if (event.type === 'service') {
    db.insert(events).values({
      ...base,
      sender: event.actor ?? null,
      senderId: event.actor?.id ?? null,
      serviceAction: event.action,
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

const reconstructServiceEvent = (row: EventRow): CanonicalServiceEvent => {
  const event: CanonicalServiceEvent = {
    type: 'service',
    chatId: row.chatId,
    receivedAtMs: row.receivedAtMs,
    timestampSec: row.timestampSec,
    utcOffsetMin: row.utcOffsetMin,
    action: row.serviceAction!,
  };
  if (row.sender) event.actor = row.sender;
  return event;
};

const reconstructRuntimeEvent = (row: EventRow): RuntimeEvent => {
  const data = row.runtimeData!;
  return {
    type: 'runtime',
    kind: data.kind,
    chatId: row.chatId,
    receivedAtMs: row.receivedAtMs,
    timestampSec: row.timestampSec,
    utcOffsetMin: row.utcOffsetMin,
    taskId: data.taskId,
    taskType: data.taskType,
    intention: data.intention,
    finalSummary: data.finalSummary,
    hasFullOutput: data.hasFullOutput,
  };
};

const reconstructEvent = (row: EventRow): PipelineEvent => {
  switch (row.type) {
  case 'message': return reconstructMessageEvent(row);
  case 'edit': return reconstructEditEvent(row);
  case 'delete': return reconstructDeleteEvent(row);
  case 'service': return reconstructServiceEvent(row);
  case 'runtime': return reconstructRuntimeEvent(row);
  default: throw new Error(`Unknown event type: ${row.type}`);
  }
};

export const loadEvents = (db: DB, chatId: string, afterMs?: number): PipelineEvent[] => {
  const cond = afterMs != null
    ? and(eq(events.chatId, chatId), gte(events.receivedAtMs, afterMs))
    : eq(events.chatId, chatId);
  const rows = db.select().from(events)
    .where(cond)
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

export const persistTurnResponse = (db: DB, chatId: string, tr: TurnResponse) => {
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

type TurnResponseRow = typeof turnResponses.$inferSelect;

const reconstructTurnResponse = (row: TurnResponseRow): TurnResponse => {
  switch (row.provider) {
  case 'openai-chat':
    return {
      requestedAtMs: row.requestedAt,
      provider: 'openai-chat',
      data: row.data as TRDataEntry[],
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      reasoningSignatureCompat: row.reasoningSignatureCompat ?? '',
    };
  case 'responses':
    return {
      requestedAtMs: row.requestedAt,
      provider: 'responses',
      data: row.data as ResponsesTRDataItem[],
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      reasoningSignatureCompat: row.reasoningSignatureCompat ?? '',
    };
  default:
    throw new Error(`Unknown turn response provider: ${row.provider}`);
  }
};

export const loadTurnResponses = (db: DB, chatId: string, afterMs?: number): TurnResponse[] => {
  const query = afterMs != null
    ? db.select().from(turnResponses)
        .where(and(eq(turnResponses.chatId, chatId), gte(turnResponses.requestedAt, afterMs)))
    : db.select().from(turnResponses)
        .where(eq(turnResponses.chatId, chatId));

  return query.orderBy(turnResponses.requestedAt, turnResponses.id).all().map(reconstructTurnResponse);
};

// --- Compaction storage (append-only) ---

export const persistCompaction = (db: DB, chatId: string, meta: CompactionSessionMeta) => {
  db.insert(compactions)
    .values({
      chatId,
      oldCursorMs: meta.oldCursorMs,
      newCursorMs: meta.newCursorMs,
      summary: meta.summary,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
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
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  };
};

// --- Probe response storage ---

type AnyMsg = Record<string, any>;

export const persistProbeResponse = (db: DB, chatId: string, probe: {
  requestedAtMs: number;
  provider: string;
  data: AnyMsg[];
  inputTokens: number;
  outputTokens: number;
  reasoningSignatureCompat: string;
  isActivated: boolean;
}) => {
  db.insert(probeResponses).values({
    chatId,
    requestedAt: probe.requestedAtMs,
    provider: probe.provider,
    data: probe.data,
    inputTokens: probe.inputTokens,
    outputTokens: probe.outputTokens,
    reasoningSignatureCompat: probe.reasoningSignatureCompat,
    isActivated: probe.isActivated,
    createdAt: Date.now(),
  }).run();
};

export const loadLastProbeTime = (db: DB, chatId: string): number => {
  const row = db.select({ requestedAt: probeResponses.requestedAt })
    .from(probeResponses)
    .where(eq(probeResponses.chatId, chatId))
    .orderBy(desc(probeResponses.id))
    .limit(1)
    .get();
  return row?.requestedAt ?? 0;
};

const reconstructImageAltTextRecord = (row: typeof imageAltTexts.$inferSelect): ImageAltTextRecord => ({
  imageHash: row.imageHash,
  altText: row.altText,
  altTextTokens: row.altTextTokens,
  ...row.stickerSetName && { stickerSetName: row.stickerSetName },
});

export const loadImageAltTextByHash = (db: DB, imageHash: string): ImageAltTextRecord | null => {
  const row = db.select().from(imageAltTexts)
    .where(eq(imageAltTexts.imageHash, imageHash))
    .limit(1)
    .get();
  return row ? reconstructImageAltTextRecord(row) : null;
};

export const persistImageAltText = (db: DB, record: ImageAltTextRecord) => {
  db.insert(imageAltTexts)
    .values({
      imageHash: record.imageHash,
      altText: record.altText,
      altTextTokens: record.altTextTokens,
      stickerSetName: record.stickerSetName ?? null,
      createdAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: imageAltTexts.imageHash,
      set: {
        altText: record.altText,
        altTextTokens: record.altTextTokens,
        stickerSetName: record.stickerSetName ?? null,
      },
    })
    .run();
};

/** Update attachments JSON on an existing event row (for backfilling animationHash). */
export const updateEventAttachments = (db: DB, eventId: number, attachments: CanonicalAttachment[]) => {
  db.update(events)
    .set({ attachments })
    .where(eq(events.id, eventId))
    .run();
};

export interface EventWithId {
  id: number;
  event: PipelineEvent;
}

export const loadEventsWithId = (db: DB, chatId: string, afterMs?: number): EventWithId[] => {
  const cond = afterMs != null
    ? and(eq(events.chatId, chatId), gte(events.receivedAtMs, afterMs))
    : eq(events.chatId, chatId);
  const rows = db.select().from(events)
    .where(cond)
    .orderBy(events.receivedAtMs, events.id)
    .all();
  return rows.map(row => ({ id: row.id, event: reconstructEvent(row) }));
};

/** Look up a file ID from the messages table for backfill download. */
export const loadMessageFileId = (db: DB, chatId: string, messageId: number): string | undefined => {
  const row = db.select({ attachments: messages.attachments })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.messageId, messageId)))
    .limit(1)
    .get();
  return row?.attachments?.[0]?.fileId;
};

/** Load all attachments for a message (used by download_file tool). */
export const loadMessageAttachments = (db: DB, chatId: string, messageId: number): Attachment[] | undefined => {
  const row = db.select({ attachments: messages.attachments })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.messageId, messageId)))
    .limit(1)
    .get();
  return row?.attachments ?? undefined;
};

// --- Background tasks storage ---

export type BackgroundTaskRow = typeof backgroundTasks.$inferSelect;

export const insertBackgroundTask = (db: DB, task: {
  sessionId: string;
  typeName: string;
  intention?: string;
  timeoutMs: number;
  params: unknown;
  startedMs: number;
}): number => {
  const result = db.insert(backgroundTasks).values({
    sessionId: task.sessionId,
    typeName: task.typeName,
    intention: task.intention ?? null,
    timeoutMs: task.timeoutMs,
    params: task.params,
    startedMs: task.startedMs,
    lastUpdatedMs: task.startedMs,
  }).run();
  return Number(result.lastInsertRowid);
};

export const loadIncompleteBackgroundTasks = (db: DB): BackgroundTaskRow[] =>
  db.select().from(backgroundTasks)
    .where(eq(backgroundTasks.completed, false))
    .all();

export const updateBackgroundTaskCheckpoint = (db: DB, id: number, checkpoint: unknown, lastUpdatedMs: number) => {
  db.update(backgroundTasks)
    .set({ checkpoint, lastUpdatedMs })
    .where(eq(backgroundTasks.id, id))
    .run();
};

export const markBackgroundTaskCompleted = (db: DB, id: number, finalSummary: string, fullOutputPath: string | null) => {
  db.update(backgroundTasks)
    .set({ completed: true, finalSummary, fullOutputPath, lastUpdatedMs: Date.now() })
    .where(eq(backgroundTasks.id, id))
    .run();
};

export const loadBackgroundTask = (db: DB, id: number): BackgroundTaskRow | undefined =>
  db.select().from(backgroundTasks)
    .where(eq(backgroundTasks.id, id))
    .get();

/** Load completed tasks for a session, newest first (for retention eviction). */
export const loadCompletedBackgroundTasks = (db: DB, sessionId: string): BackgroundTaskRow[] =>
  db.select().from(backgroundTasks)
    .where(and(eq(backgroundTasks.sessionId, sessionId), eq(backgroundTasks.completed, true)))
    .orderBy(desc(backgroundTasks.id))
    .all();
