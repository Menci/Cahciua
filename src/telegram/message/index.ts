import type { Attachment, TelegramMessage, TelegramUser } from './types';

export type {
  Attachment,
  ForwardInfo,
  MessageEntity,
  TelegramMessage,
  TelegramMessageDelete,
  TelegramMessageEdit,
  TelegramUser,
} from './types';

export {
  fromGramjsAnyMessage,
  fromGramjsDeletedMessage,
  fromGramjsEditedMessage,
  fromGramjsMessage,
  fromGramjsServiceMessage,
  resolveGramjsChatId,
  resolveGramjsSender,
} from './gramjs';

export { convertGrammyEntities, fromGrammyMessage } from './grammy';

export { createMessageDedup } from './dedup';

const mergeTelegramUser = (target: TelegramUser | undefined, source: TelegramUser | undefined): TelegramUser | undefined => {
  if (!target) return source;
  if (!source) return target;

  return {
    id: target.id,
    firstName: target.firstName || source.firstName,
    lastName: target.lastName ?? source.lastName,
    username: target.username ?? source.username,
    isBot: target.isBot || source.isBot,
    isPremium: target.isPremium || source.isPremium,
  };
};

const mergeTelegramUsers = (
  target: TelegramUser[] | undefined,
  source: TelegramUser[] | undefined,
): TelegramUser[] | undefined => {
  if (!target) return source;
  if (!source) return target;
  if (target.length !== source.length) return source;

  return target.map((user, index) => {
    const incoming = source[index];
    if (incoming?.id !== user.id) return incoming ?? user;
    return mergeTelegramUser(user, incoming) ?? user;
  });
};

const mergeAttachments = (target?: Attachment[], source?: Attachment[]) => {
  if (!target || !source) return;

  for (let i = 0; i < target.length && i < source.length; i++) {
    const existing = target[i]!;
    const incoming = source[i]!;
    if (!existing.fileId && incoming.fileId) {
      existing.fileId = incoming.fileId;
      existing.fileUniqueId = incoming.fileUniqueId;
    }
  }
};

export const mergeTelegramMessageData = (target: TelegramMessage, source: TelegramMessage) => {
  target.sender = mergeTelegramUser(target.sender, source.sender);
  target.editDate ??= source.editDate;
  if (!target.text) target.text = source.text;
  target.entities ??= source.entities;
  target.replyToMessageId ??= source.replyToMessageId;
  target.replyToTopId ??= source.replyToTopId;
  target.forwardInfo ??= source.forwardInfo;
  target.mediaGroupId ??= source.mediaGroupId;
  target.viaBotId ??= source.viaBotId;
  target.newChatMembers = mergeTelegramUsers(target.newChatMembers, source.newChatMembers);
  target.leftChatMember = mergeTelegramUser(target.leftChatMember, source.leftChatMember);
  target.newChatTitle ??= source.newChatTitle;
  target.newChatPhoto ??= source.newChatPhoto;
  target.deleteChatPhoto ??= source.deleteChatPhoto;
  target.pinnedMessage ??= source.pinnedMessage;

  if (!target.attachments) {
    target.attachments = source.attachments;
  } else {
    mergeAttachments(target.attachments, source.attachments);
  }
};
