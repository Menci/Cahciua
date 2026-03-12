import { Api } from 'telegram';

import type { Attachment, ForwardInfo, MessageEntity, TelegramMessage, TelegramMessageDelete, TelegramMessageEdit, TelegramUser } from './types';

// --- peer → chatId ---

const resolveChatId = (peer: Api.TypePeer): string => {
  if (peer instanceof Api.PeerChannel) return `-100${peer.channelId.toJSNumber()}`;
  if (peer instanceof Api.PeerChat) return `-${peer.chatId.toJSNumber()}`;
  if (peer instanceof Api.PeerUser) return String(peer.userId.toJSNumber());
  throw new Error(`Unknown peer type: ${String(peer)}`);
};

// --- entity conversion ---

const ENTITY_CLASS_TO_TYPE: Record<string, string> = {
  MessageEntityUnknown: 'unknown',
  MessageEntityMention: 'mention',
  MessageEntityHashtag: 'hashtag',
  MessageEntityBotCommand: 'bot_command',
  MessageEntityUrl: 'url',
  MessageEntityEmail: 'email',
  MessageEntityBold: 'bold',
  MessageEntityItalic: 'italic',
  MessageEntityCode: 'code',
  MessageEntityPre: 'pre',
  MessageEntityTextUrl: 'text_link',
  MessageEntityMentionName: 'text_mention',
  InputMessageEntityMentionName: 'text_mention',
  MessageEntityPhone: 'phone_number',
  MessageEntityCashtag: 'cashtag',
  MessageEntityUnderline: 'underline',
  MessageEntityStrike: 'strikethrough',
  MessageEntityBankCard: 'bank_card',
  MessageEntitySpoiler: 'spoiler',
  MessageEntityCustomEmoji: 'custom_emoji',
  MessageEntityBlockquote: 'blockquote',
};

const convertGramjsEntities = (entities?: Api.TypeMessageEntity[]): MessageEntity[] | undefined => {
  if (!entities || entities.length === 0) return undefined;

  return entities.map(e => {
    const type = ENTITY_CLASS_TO_TYPE[e.className] ?? e.className;
    const result: MessageEntity = {
      type,
      offset: e.offset,
      length: e.length,
    };

    if (e instanceof Api.MessageEntityTextUrl) result.url = e.url;
    if (e instanceof Api.MessageEntityPre) result.language = e.language;
    if (e instanceof Api.MessageEntityMentionName) result.userId = String(e.userId.toJSNumber());
    if (e instanceof Api.MessageEntityCustomEmoji) result.customEmojiId = String(e.documentId.toJSNumber());

    return result;
  });
};

// --- forward info ---

const convertGramjsForwardInfo = (fwd?: Api.TypeMessageFwdHeader): ForwardInfo | undefined => {
  if (!fwd || !(fwd instanceof Api.MessageFwdHeader)) return undefined;

  const info: ForwardInfo = { date: fwd.date };

  if (fwd.fromId) {
    if (fwd.fromId instanceof Api.PeerUser) {
      info.fromUserId = String(fwd.fromId.userId.toJSNumber());
    } else if (fwd.fromId instanceof Api.PeerChannel) {
      info.fromChatId = `-100${fwd.fromId.channelId.toJSNumber()}`;
      if (fwd.channelPost) info.fromMessageId = fwd.channelPost;
    } else if (fwd.fromId instanceof Api.PeerChat) {
      info.fromChatId = `-${fwd.fromId.chatId.toJSNumber()}`;
    }
  }

  if (fwd.fromName) info.senderName = fwd.fromName;

  return info;
};

// --- media → attachments ---

const convertGramjsMedia = (media?: Api.TypeMessageMedia): Attachment[] | undefined => {
  if (!media) return undefined;

  if (media instanceof Api.MessageMediaPhoto) {
    if (!media.photo || !(media.photo instanceof Api.Photo)) return undefined;
    const largest = media.photo.sizes
      .filter((s): s is Api.PhotoSize => s instanceof Api.PhotoSize)
      .toSorted((a, b) => b.w * b.h - a.w * a.h)[0];
    const attachment: Attachment = {
      type: 'photo',
      width: largest?.w,
      height: largest?.h,
      hasSpoiler: media.spoiler,
    };
    return [attachment];
  }

  if (media instanceof Api.MessageMediaDocument) {
    if (!media.document || !(media.document instanceof Api.Document)) return undefined;
    return [convertGramjsDocument(media.document, media.spoiler)];
  }

  return undefined;
};

const convertGramjsDocument = (doc: Api.Document, spoiler?: boolean): Attachment => {
  const stickerAttr = doc.attributes.find(
    (a): a is Api.DocumentAttributeSticker => a instanceof Api.DocumentAttributeSticker,
  );
  const videoAttr = doc.attributes.find(
    (a): a is Api.DocumentAttributeVideo => a instanceof Api.DocumentAttributeVideo,
  );
  const audioAttr = doc.attributes.find(
    (a): a is Api.DocumentAttributeAudio => a instanceof Api.DocumentAttributeAudio,
  );
  const filenameAttr = doc.attributes.find(
    (a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename,
  );
  const isAnimated = doc.attributes.some(a => a instanceof Api.DocumentAttributeAnimated);
  const isCustomEmoji = doc.attributes.find(
    (a): a is Api.DocumentAttributeCustomEmoji => a instanceof Api.DocumentAttributeCustomEmoji,
  );

  const attachment: Attachment = { type: 'document' };

  if (stickerAttr || isCustomEmoji) {
    attachment.type = 'sticker';
    const attr = stickerAttr ?? isCustomEmoji;
    if (attr) attachment.emoji = attr.alt;
    if (stickerAttr?.stickerset instanceof Api.InputStickerSetShortName) {
      attachment.stickerSetName = stickerAttr.stickerset.shortName;
    }
    if (videoAttr) attachment.isVideoSticker = true;
    if (doc.mimeType === 'application/x-tgsticker') attachment.isAnimatedSticker = true;
    if (isCustomEmoji) attachment.customEmojiId = String(doc.id.toJSNumber());
  } else if (videoAttr?.roundMessage) {
    attachment.type = 'video_note';
    attachment.width = videoAttr.w;
    attachment.height = videoAttr.h;
    attachment.duration = videoAttr.duration;
  } else if (isAnimated && videoAttr) {
    attachment.type = 'animation';
    attachment.width = videoAttr.w;
    attachment.height = videoAttr.h;
    attachment.duration = videoAttr.duration;
  } else if (videoAttr) {
    attachment.type = 'video';
    attachment.width = videoAttr.w;
    attachment.height = videoAttr.h;
    attachment.duration = videoAttr.duration;
  } else if (audioAttr?.voice) {
    attachment.type = 'voice';
    attachment.duration = audioAttr.duration;
  } else if (audioAttr) {
    attachment.type = 'audio';
    attachment.duration = audioAttr.duration;
  }

  attachment.mimeType = doc.mimeType;
  attachment.fileSize = doc.size.toJSNumber();
  if (filenameAttr) attachment.fileName = filenameAttr.fileName;
  if (spoiler) attachment.hasSpoiler = true;

  return attachment;
};

// --- public API ---

export const resolveGramjsSender = (message: Api.Message): TelegramUser | undefined => {
  const fromId = message.fromId;

  if (fromId instanceof Api.PeerUser) {
    const userId = fromId.userId.toJSNumber();
    const sender = message.sender;
    if (sender && sender instanceof Api.User) {
      return {
        id: String(userId),
        firstName: sender.firstName ?? '',
        lastName: sender.lastName,
        username: sender.username,
        isBot: sender.bot ?? false,
        isPremium: sender.premium ?? false,
      };
    }
    return {
      id: String(userId),
      firstName: '',
      isBot: false,
      isPremium: false,
    };
  }

  if (fromId instanceof Api.PeerChannel) {
    const channelId = fromId.channelId.toJSNumber();
    const sender = message.sender;
    if (sender && sender instanceof Api.Channel) {
      return {
        id: `-100${channelId}`,
        firstName: sender.title ?? '',
        username: sender.username,
        isBot: false,
        isPremium: false,
      };
    }
    return {
      id: `-100${channelId}`,
      firstName: '',
      isBot: false,
      isPremium: false,
    };
  }

  return undefined;
};

const convertGramjsMessageBase = (message: Api.Message, senderInfo?: TelegramUser) => {
  const replyTo = message.replyTo instanceof Api.MessageReplyHeader ? message.replyTo : undefined;
  return {
    messageId: message.id,
    chatId: resolveChatId(message.peerId),
    sender: senderInfo,
    date: message.date,
    text: message.rawText,
    entities: convertGramjsEntities(message.entities),
    replyToMessageId: replyTo?.replyToMsgId,
    replyToTopId: replyTo?.replyToTopId,
    attachments: convertGramjsMedia(message.media),
  };
};

export const fromGramjsMessage = (
  message: Api.Message,
  senderInfo?: TelegramUser,
): TelegramMessage => ({
  ...convertGramjsMessageBase(message, senderInfo),
  editDate: message.editDate,
  forwardInfo: convertGramjsForwardInfo(message.fwdFrom),
  mediaGroupId: message.groupedId ? String(message.groupedId) : undefined,
  viaBotId: message.viaBotId ? String(message.viaBotId.toJSNumber()) : undefined,
  source: 'userbot',
});

export const fromGramjsEditedMessage = (
  message: Api.Message,
  senderInfo?: TelegramUser,
): TelegramMessageEdit => ({
  ...convertGramjsMessageBase(message, senderInfo),
  editDate: message.editDate ?? message.date,
});

export const fromGramjsDeletedMessage = (
  deletedIds: number[],
  peer?: Api.PeerChannel,
): TelegramMessageDelete => {
  let chatId: string | undefined;
  if (peer) {
    chatId = `-100${peer.channelId.toJSNumber()}`;
  }
  return { messageIds: deletedIds, chatId };
};
