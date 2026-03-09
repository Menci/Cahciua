import type {
  CanonicalAttachment,
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalEntity,
  CanonicalForwardInfo,
  CanonicalMessageEvent,
  CanonicalUser,
} from './types';
import type { Attachment, ForwardInfo, MessageEntity } from '../db/schema';
import type { TelegramMessage, TelegramMessageDelete, TelegramMessageEdit, TelegramUser } from '../telegram/message';

export type {
  CanonicalAttachment,
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalEntity,
  CanonicalEvent,
  CanonicalForwardInfo,
  CanonicalMessageEvent,
  CanonicalUser,
} from './types';

const adaptUser = (user: TelegramUser): CanonicalUser => ({
  id: user.id,
  displayName: [user.firstName, user.lastName].filter(Boolean).join(' '),
  username: user.username,
  isBot: user.isBot,
});

const adaptAttachment = (a: Attachment): CanonicalAttachment => {
  const result: CanonicalAttachment = { type: a.type };
  if (a.mimeType) result.mimeType = a.mimeType;
  if (a.fileName) result.fileName = a.fileName;
  if (a.width != null) result.width = a.width;
  if (a.height != null) result.height = a.height;
  if (a.duration != null) result.duration = a.duration;
  if (a.thumbnail) result.thumbnail = a.thumbnail;
  return result;
};

const adaptAttachments = (attachments?: Attachment[]): CanonicalAttachment[] => {
  if (!attachments || attachments.length === 0) return [];
  return attachments.map(adaptAttachment);
};

const adaptEntities = (entities?: MessageEntity[]): CanonicalEntity[] | undefined => {
  if (!entities || entities.length === 0) return undefined;
  return entities.map(e => {
    const result: CanonicalEntity = {
      type: e.type,
      offset: e.offset,
      length: e.length,
    };
    if (e.url) result.url = e.url;
    if (e.language) result.language = e.language;
    if (e.userId) result.userId = e.userId;
    if (e.customEmojiId) result.customEmojiId = e.customEmojiId;
    return result;
  });
};

const adaptForwardInfo = (info?: ForwardInfo): CanonicalForwardInfo | undefined => {
  if (!info) return undefined;
  const result: CanonicalForwardInfo = {};
  if (info.fromUserId) result.fromUserId = info.fromUserId;
  if (info.fromChatId) result.fromChatId = info.fromChatId;
  if (info.senderName) result.senderName = info.senderName;
  if (info.date != null) result.date = info.date;
  return result;
};

export const adaptMessage = (msg: TelegramMessage): CanonicalMessageEvent => {
  const event: CanonicalMessageEvent = {
    type: 'message',
    chatId: msg.chatId,
    messageId: msg.messageId,
    timestamp: msg.date,
    text: msg.text,
    attachments: adaptAttachments(msg.attachments),
  };
  if (msg.sender) event.sender = adaptUser(msg.sender);
  const entities = adaptEntities(msg.entities);
  if (entities) event.entities = entities;
  if (msg.replyToMessageId != null) event.replyToMessageId = msg.replyToMessageId;
  const forwardInfo = adaptForwardInfo(msg.forwardInfo);
  if (forwardInfo) event.forwardInfo = forwardInfo;
  return event;
};

export const adaptEdit = (edit: TelegramMessageEdit): CanonicalEditEvent => {
  const event: CanonicalEditEvent = {
    type: 'edit',
    chatId: edit.chatId,
    messageId: edit.messageId,
    timestamp: edit.editDate,
    text: edit.text,
    attachments: adaptAttachments(edit.attachments),
  };
  if (edit.sender) event.sender = adaptUser(edit.sender);
  const entities = adaptEntities(edit.entities);
  if (entities) event.entities = entities;
  return event;
};

export const adaptDelete = (del: TelegramMessageDelete): CanonicalDeleteEvent => ({
  type: 'delete',
  chatId: del.chatId,
  messageIds: del.messageIds,
  timestamp: Math.floor(Date.now() / 1000),
});
