import type {
  CanonicalAttachment,
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalForwardInfo,
  CanonicalMessageEvent,
  CanonicalUser,
  ContentNode,
} from './types';
import type { Attachment, ForwardInfo, MessageEntity, TelegramMessage, TelegramMessageDelete, TelegramMessageEdit, TelegramUser } from '../telegram/message';

export type {
  CanonicalAttachment,
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalIMEvent,
  CanonicalForwardInfo,
  CanonicalMessageEvent,
  CanonicalUser,
  ContentNode,
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

const adaptForwardInfo = (info?: ForwardInfo): CanonicalForwardInfo | undefined => {
  if (!info) return undefined;
  const result: CanonicalForwardInfo = {};
  if (info.fromUserId) result.fromUserId = info.fromUserId;
  if (info.fromChatId) result.fromChatId = info.fromChatId;
  if (info.senderName) result.senderName = info.senderName;
  if (info.date != null) result.date = info.date;
  return Object.keys(result).length > 0 ? result : undefined;
};

// --- Rich text parser: Telegram's text + offset-based entities → ContentNode tree ---

const entityToNode = (
  entity: MessageEntity,
  rawText: string,
  children: ContentNode[],
): ContentNode => {
  switch (entity.type) {
  // Leaf nodes — raw text, no nested formatting
  case 'code':
    return { type: 'code', text: rawText };
  case 'pre':
    return entity.language
      ? { type: 'pre', text: rawText, language: entity.language }
      : { type: 'pre', text: rawText };

  // Container nodes
  case 'bold':
  case 'italic':
  case 'underline':
  case 'strikethrough':
  case 'spoiler':
  case 'blockquote':
    return { type: entity.type, children };
  case 'expandable_blockquote':
    return { type: 'blockquote', children };

  // Links
  case 'text_link':
    return { type: 'link', url: entity.url!, children };
  case 'url':
    return { type: 'link', url: rawText, children };

  // Mentions
  case 'mention':
    return { type: 'mention', children };
  case 'text_mention':
    return { type: 'mention', userId: entity.userId!, children };

  // Custom emoji
  case 'custom_emoji':
    return { type: 'custom_emoji', customEmojiId: entity.customEmojiId!, children };

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

    // Skip entities outside our range
    if (entityStart < start || entityEnd > end) {
      i++;
      continue;
    }

    // Plain text before this entity
    if (entityStart > pos) {
      nodes.push({ type: 'text', text: text.slice(pos, entityStart) });
    }

    // Collect child entities (fully contained within this entity)
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

  // Trailing text
  if (pos < end) {
    nodes.push({ type: 'text', text: text.slice(pos, end) });
  }

  return nodes;
};

export const parseContent = (text: string, entities?: MessageEntity[]): ContentNode[] => {
  if (!entities || entities.length === 0) {
    return text ? [{ type: 'text', text }] : [];
  }
  // Sort by offset ascending, length descending (outer entities first for nesting)
  const sorted = [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length);
  return buildContentTree(text, sorted, 0, text.length);
};

export const contentToPlainText = (nodes: ContentNode[]): string =>
  nodes.map(node => 'children' in node ? contentToPlainText(node.children) : node.text).join('');

// --- Adapt functions ---

const captureUtcOffset = (): number => -new Date().getTimezoneOffset();

export const adaptMessage = (msg: TelegramMessage): CanonicalMessageEvent => {
  const event: CanonicalMessageEvent = {
    type: 'message',
    chatId: msg.chatId,
    messageId: String(msg.messageId),
    receivedAtMs: Date.now(),
    timestampSec: msg.date,
    utcOffsetMin: captureUtcOffset(),
    content: parseContent(msg.text, msg.entities),
    attachments: adaptAttachments(msg.attachments),
  };
  if (msg.sender) event.sender = adaptUser(msg.sender);
  if (msg.replyToMessageId != null) event.replyToMessageId = String(msg.replyToMessageId);
  const forwardInfo = adaptForwardInfo(msg.forwardInfo);
  if (forwardInfo) event.forwardInfo = forwardInfo;
  return event;
};

export const adaptEdit = (edit: TelegramMessageEdit): CanonicalEditEvent => {
  const event: CanonicalEditEvent = {
    type: 'edit',
    chatId: edit.chatId,
    messageId: String(edit.messageId),
    receivedAtMs: Date.now(),
    timestampSec: edit.editDate,
    utcOffsetMin: captureUtcOffset(),
    content: parseContent(edit.text, edit.entities),
    attachments: adaptAttachments(edit.attachments),
  };
  if (edit.sender) event.sender = adaptUser(edit.sender);
  return event;
};

export const adaptDelete = (del: TelegramMessageDelete): CanonicalDeleteEvent => {
  if (!del.chatId) throw new Error('Cannot adapt delete event without chatId');
  const now = Date.now();
  return {
    type: 'delete',
    chatId: del.chatId,
    messageIds: del.messageIds.map(String),
    receivedAtMs: now,
    timestampSec: Math.floor(now / 1000),
    utcOffsetMin: captureUtcOffset(),
  };
};
