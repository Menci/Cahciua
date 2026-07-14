import type { IngressTelegramMessage, IngressTelegramMessageDelete, IngressTelegramMessageEdit } from './ingress-meta';
import type { Attachment, ForwardInfo, MessageEntity, TelegramMessage, TelegramUser } from './message';
import type {
  CanonicalAttachment,
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalForwardInfo,
  CanonicalMessageEvent,
  CanonicalServiceEvent,
  CanonicalUser,
  ContentNode,
  ServiceAction,
} from '../adaptation/types';

const adaptUser = (user: TelegramUser): CanonicalUser => {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  const displayName = name !== '' ? name : (user.username ?? user.id);

  return {
    id: user.id,
    displayName,
    username: user.username,
    isBot: user.isBot,
  };
};

const adaptAttachment = ({ type, mimeType, fileName, width, height, duration, thumbnailWebp, animationHash, stickerSetId, stickerSetName }: Attachment): CanonicalAttachment => ({
  type,
  ...mimeType && { mimeType },
  ...fileName && { fileName },
  ...width != null && { width },
  ...height != null && { height },
  ...duration != null && { duration },
  ...thumbnailWebp && { thumbnailWebp },
  ...animationHash && { animationHash },
  ...stickerSetId && { stickerSetId },
  ...stickerSetName && { stickerSetName },
});

const adaptAttachments = (attachments?: Attachment[]): CanonicalAttachment[] => {
  if (!attachments || attachments.length === 0) return [];
  return attachments.map(adaptAttachment);
};

const adaptForwardInfo = (info?: ForwardInfo): CanonicalForwardInfo | undefined => {
  if (!info) return undefined;
  if (!info.fromUserId && !info.fromChatId && !info.sender && !info.senderName && info.date == null) return undefined;
  const result: CanonicalForwardInfo = {};
  if (info.fromUserId) result.fromUserId = info.fromUserId;
  if (info.fromChatId) result.fromChatId = info.fromChatId;
  if (info.sender) result.sender = adaptUser(info.sender);
  if (info.senderName) result.senderName = info.senderName;
  if (info.date != null) result.date = info.date;
  return result;
};

const entityToNode = (
  entity: MessageEntity,
  rawText: string,
  children: ContentNode[],
): ContentNode => {
  const requireField = <T>(value: T | undefined, field: string): T => {
    if (value === undefined) throw new Error(`Telegram ${entity.type} entity has no ${field}`);
    return value;
  };
  switch (entity.type) {
  case 'code':
    return { type: 'code', text: rawText };
  case 'pre':
    return entity.language
      ? { type: 'pre', text: rawText, language: entity.language }
      : { type: 'pre', text: rawText };

  case 'bold':
  case 'italic':
  case 'underline':
  case 'strikethrough':
  case 'spoiler':
  case 'blockquote':
    return { type: entity.type, children };
  case 'expandable_blockquote':
    return { type: 'blockquote', children };

  case 'text_link':
    return { type: 'link', url: requireField(entity.url, 'url'), children };
  case 'url':
    return { type: 'link', url: rawText, children };

  case 'mention':
    return { type: 'mention', children };
  case 'text_mention':
    return { type: 'mention', userId: requireField(entity.userId, 'userId'), children };

  case 'custom_emoji':
    return {
      type: 'custom_emoji',
      customEmojiId: requireField(entity.customEmojiId, 'customEmojiId'),
      children,
      ...entity.customEmojiSetId && { stickerSetId: entity.customEmojiSetId },
      ...entity.customEmojiSetName && { stickerSetName: entity.customEmojiSetName },
      ...entity.customEmojiFormat && { format: entity.customEmojiFormat },
    };

  // Unknown / informational types (hashtag, bot_command, email, phone_number, etc.)
  // — treat as plain text, forward-compatible with new entity types
  default:
    return { type: 'text', text: rawText };
  }
};

const buildContentTree = (
  text: string,
  entities: MessageEntity[],
  start: number,
  end: number,
): ContentNode[] => {
  const nodes: ContentNode[] = [];
  let pos = start;
  let i = 0;

  while (i < entities.length) {
    const entity = entities[i]!;
    const entityStart = entity.offset;
    const entityEnd = entity.offset + entity.length;

    if (entityStart < start || entityEnd > end) {
      i++;
      continue;
    }

    if (entityStart > pos) {
      nodes.push({ type: 'text', text: text.slice(pos, entityStart) });
    }

    const children: MessageEntity[] = [];
    let j = i + 1;
    while (j < entities.length && entities[j]!.offset < entityEnd) {
      if (entities[j]!.offset + entities[j]!.length <= entityEnd) {
        children.push(entities[j]!);
      }
      j++;
    }

    const rawText = text.slice(entityStart, entityEnd);
    const childNodes = children.length > 0
      ? buildContentTree(text, children, entityStart, entityEnd)
      : [{ type: 'text' as const, text: rawText }];

    nodes.push(entityToNode(entity, rawText, childNodes));
    pos = entityEnd;
    i = j;
  }

  if (pos < end) {
    nodes.push({ type: 'text', text: text.slice(pos, end) });
  }

  return nodes;
};

export const parseContent = (text: string, entities?: MessageEntity[]): ContentNode[] => {
  if (!entities || entities.length === 0) {
    return text ? [{ type: 'text', text }] : [];
  }
  const sorted = [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length);
  return buildContentTree(text, sorted, 0, text.length);
};

export const adaptMessage = (msg: IngressTelegramMessage): CanonicalMessageEvent => {
  const event: CanonicalMessageEvent = {
    type: 'message',
    chatId: msg.chatId,
    messageId: String(msg.messageId),
    receivedAtMs: msg.receivedAtMs,
    timestampSec: msg.date,
    utcOffsetMin: msg.utcOffsetMin,
    content: parseContent(msg.text, msg.entities),
    attachments: adaptAttachments(msg.attachments),
  };
  if (msg.sender) event.sender = adaptUser(msg.sender);
  if (msg.replyToMessageId != null) event.replyToMessageId = String(msg.replyToMessageId);
  if (msg.replyQuote) event.replyQuoteContent = parseContent(msg.replyQuote.text, msg.replyQuote.entities);
  const forwardInfo = adaptForwardInfo(msg.forwardInfo);
  if (forwardInfo) event.forwardInfo = forwardInfo;
  return event;
};

export const adaptEdit = (edit: IngressTelegramMessageEdit): CanonicalEditEvent => {
  const event: CanonicalEditEvent = {
    type: 'edit',
    chatId: edit.chatId,
    messageId: String(edit.messageId),
    receivedAtMs: edit.receivedAtMs,
    timestampSec: edit.editDate,
    utcOffsetMin: edit.utcOffsetMin,
    content: parseContent(edit.text, edit.entities),
    attachments: adaptAttachments(edit.attachments),
  };
  if (edit.sender) event.sender = adaptUser(edit.sender);
  return event;
};

export const adaptDelete = (del: IngressTelegramMessageDelete): CanonicalDeleteEvent => {
  return {
    type: 'delete',
    chatId: del.chatId,
    messageIds: del.messageIds.map(String),
    receivedAtMs: del.receivedAtMs,
    timestampSec: Math.floor(del.receivedAtMs / 1000),
    utcOffsetMin: del.utcOffsetMin,
  };
};

export const isServiceMessage = (msg: TelegramMessage): boolean => {
  if (msg.newChatMembers != null) return true;
  if (msg.leftChatMember != null) return true;
  if (msg.newChatTitle != null) return true;
  if (msg.newChatPhoto === true) return true;
  if (msg.deleteChatPhoto === true) return true;
  return msg.pinnedMessage != null;
};

export const adaptServiceEvent = (msg: IngressTelegramMessage): CanonicalServiceEvent => {
  let action: ServiceAction | null = null;

  if (msg.newChatMembers && msg.newChatMembers.length > 0) {
    action = { action: 'members_joined', members: msg.newChatMembers.map(adaptUser) };
  } else if (msg.leftChatMember) {
    action = { action: 'member_left', member: adaptUser(msg.leftChatMember) };
  } else if (msg.newChatTitle != null) {
    action = { action: 'chat_renamed', newTitle: msg.newChatTitle };
  } else if (msg.newChatPhoto) {
    action = { action: 'chat_photo_changed' };
  } else if (msg.deleteChatPhoto) {
    action = { action: 'chat_photo_deleted' };
  } else if (msg.pinnedMessage) {
    action = { action: 'message_pinned', messageId: String(msg.pinnedMessage.messageId) };
  }

  if (!action) throw new Error('Telegram message is not a service event');

  const event: CanonicalServiceEvent = {
    type: 'service',
    chatId: msg.chatId,
    receivedAtMs: msg.receivedAtMs,
    timestampSec: msg.date,
    utcOffsetMin: msg.utcOffsetMin,
    action,
  };
  if (msg.sender) event.actor = adaptUser(msg.sender);
  return event;
};
