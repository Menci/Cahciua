import { Api } from 'telegram';

import type { Attachment, ForwardInfo, MessageEntity } from '../db/schema';

export interface TelegramUser {
  id: string;
  firstName: string;
  lastName?: string;
  username?: string;
  isBot: boolean;
  isPremium: boolean;
}

export interface TelegramMessage {
  messageId: number;
  chatId: string;
  sender?: TelegramUser;
  date: number;
  editDate?: number;
  text: string;
  entities?: MessageEntity[];
  replyToMessageId?: number;
  replyToTopId?: number;
  forwardInfo?: ForwardInfo;
  mediaGroupId?: string;
  viaBotId?: string;
  attachments?: Attachment[];
  source: 'bot' | 'userbot';
}

export interface TelegramMessageEdit {
  messageId: number;
  chatId: string;
  sender?: TelegramUser;
  date: number;
  editDate: number;
  text: string;
  entities?: MessageEntity[];
  replyToMessageId?: number;
  attachments?: Attachment[];
}

export interface TelegramMessageDelete {
  messageIds: number[];
  chatId?: string;
}

// --- gramjs peer → chatId ---

function resolveChatId(peer: Api.TypePeer): string {
  if (peer instanceof Api.PeerChannel) return `-100${peer.channelId.toJSNumber()}`;
  if (peer instanceof Api.PeerChat) return `-${peer.chatId.toJSNumber()}`;
  if (peer instanceof Api.PeerUser) return String(peer.userId.toJSNumber());
  throw new Error(`Unknown peer type: ${String(peer)}`);
}

// --- gramjs entity conversion ---

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

function convertGramjsEntities(entities?: Api.TypeMessageEntity[]): MessageEntity[] | undefined {
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
}

// --- gramjs forward info ---

function convertGramjsForwardInfo(fwd?: Api.TypeMessageFwdHeader): ForwardInfo | undefined {
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
}

// --- gramjs media → attachments ---

function convertGramjsMedia(media?: Api.TypeMessageMedia): Attachment[] | undefined {
  if (!media) return undefined;

  if (media instanceof Api.MessageMediaPhoto) {
    if (!media.photo || !(media.photo instanceof Api.Photo)) return undefined;
    const largest = media.photo.sizes
      .filter((s): s is Api.PhotoSize => s instanceof Api.PhotoSize)
      .sort((a, b) => b.w * b.h - a.w * a.h)[0];
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
    const doc = media.document;
    return [convertGramjsDocument(doc, media.spoiler)];
  }

  return undefined;
}

function convertGramjsDocument(doc: Api.Document, spoiler?: boolean): Attachment {
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

  const type: Attachment['type'] = 'document';
  const attachment: Attachment = { type };

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
}

// --- gramjs public API ---

export function resolveGramjsSender(message: Api.Message): TelegramUser | undefined {
  const fromId = message.fromId;
  if (fromId && fromId instanceof Api.PeerUser) {
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
  return undefined;
}

export function fromGramjsMessage(
  message: Api.Message,
  senderInfo?: TelegramUser,
): TelegramMessage {
  const replyTo = message.replyTo instanceof Api.MessageReplyHeader ? message.replyTo : undefined;

  return {
    messageId: message.id,
    chatId: resolveChatId(message.peerId),
    sender: senderInfo,
    date: message.date,
    editDate: message.editDate,
    text: message.text,
    entities: convertGramjsEntities(message.entities),
    replyToMessageId: replyTo?.replyToMsgId,
    replyToTopId: replyTo?.replyToTopId,
    forwardInfo: convertGramjsForwardInfo(message.fwdFrom),
    mediaGroupId: message.groupedId ? String(message.groupedId) : undefined,
    viaBotId: message.viaBotId ? String(message.viaBotId.toJSNumber()) : undefined,
    attachments: convertGramjsMedia(message.media),
    source: 'userbot',
  };
}

export function fromGramjsEditedMessage(
  message: Api.Message,
  senderInfo?: TelegramUser,
): TelegramMessageEdit {
  const base = fromGramjsMessage(message, senderInfo);
  return {
    messageId: base.messageId,
    chatId: base.chatId,
    sender: base.sender,
    date: base.date,
    editDate: message.editDate ?? base.date,
    text: base.text,
    entities: base.entities,
    replyToMessageId: base.replyToMessageId,
    attachments: base.attachments,
  };
}

export function fromGramjsDeletedMessage(
  deletedIds: number[],
  peer?: Api.PeerChannel,
): TelegramMessageDelete {
  let chatId: string | undefined;
  if (peer) {
    chatId = `-100${peer.channelId.toJSNumber()}`;
  }
  return { messageIds: deletedIds, chatId };
}

// --- grammY conversion ---

interface GrammyMessageInput {
  message_id: number;
  chat: { id: number };
  from?: { id: number; first_name: string; last_name?: string; username?: string; is_bot: boolean; is_premium?: true };
  date: number;
  edit_date?: number;
  text?: string;
  caption?: string;
  entities?: Array<{ type: string; offset: number; length: number; url?: string; language?: string; custom_emoji_id?: string; user?: { id: number } }>;
  caption_entities?: Array<{ type: string; offset: number; length: number; url?: string; language?: string; custom_emoji_id?: string; user?: { id: number } }>;
  reply_to_message?: { message_id: number };
  forward_origin?: {
    type: string;
    date: number;
    sender_user?: { id: number };
    sender_user_name?: string;
    sender_chat?: { id: number };
    chat?: { id: number };
    message_id?: number;
  };
  media_group_id?: string;
  via_bot?: { id: number };
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
  sticker?: {
    file_id: string; file_unique_id: string; width: number; height: number;
    is_animated: boolean; is_video: boolean;
    emoji?: string; set_name?: string; custom_emoji_id?: string;
    file_size?: number;
  };
  animation?: { file_id: string; file_unique_id: string; width: number; height: number; duration: number; file_name?: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; file_unique_id: string; duration: number; file_name?: string; mime_type?: string; file_size?: number };
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
  video?: { file_id: string; file_unique_id: string; width: number; height: number; duration: number; file_name?: string; mime_type?: string; file_size?: number };
  video_note?: { file_id: string; file_unique_id: string; length: number; duration: number; file_size?: number };
  voice?: { file_id: string; file_unique_id: string; duration: number; mime_type?: string; file_size?: number };
  has_media_spoiler?: true;
}

function convertGrammyEntities(
  entities?: GrammyMessageInput['entities'],
): MessageEntity[] | undefined {
  if (!entities || entities.length === 0) return undefined;
  return entities.map(e => ({
    type: e.type,
    offset: e.offset,
    length: e.length,
    url: e.url,
    language: e.language,
    customEmojiId: e.custom_emoji_id,
    userId: e.user ? String(e.user.id) : undefined,
  }));
}

function convertGrammyForwardInfo(
  origin?: GrammyMessageInput['forward_origin'],
): ForwardInfo | undefined {
  if (!origin) return undefined;

  const info: ForwardInfo = { date: origin.date };

  switch (origin.type) {
  case 'user':
    if (origin.sender_user) info.fromUserId = String(origin.sender_user.id);
    break;
  case 'hidden_user':
    if (origin.sender_user_name) info.senderName = origin.sender_user_name;
    break;
  case 'chat':
    if (origin.sender_chat) info.fromChatId = String(origin.sender_chat.id);
    break;
  case 'channel':
    if (origin.chat) info.fromChatId = String(origin.chat.id);
    if (origin.message_id) info.fromMessageId = origin.message_id;
    break;
  }

  return info;
}

function convertGrammyAttachments(msg: GrammyMessageInput): Attachment[] | undefined {
  const spoiler = msg.has_media_spoiler;

  if (msg.photo) {
    const largest = msg.photo.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!largest) return undefined;
    return [{
      type: 'photo',
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id,
      width: largest.width,
      height: largest.height,
      fileSize: largest.file_size,
      hasSpoiler: spoiler,
    }];
  }

  if (msg.sticker) {
    return [{
      type: 'sticker',
      fileId: msg.sticker.file_id,
      fileUniqueId: msg.sticker.file_unique_id,
      width: msg.sticker.width,
      height: msg.sticker.height,
      emoji: msg.sticker.emoji,
      stickerSetName: msg.sticker.set_name,
      isAnimatedSticker: msg.sticker.is_animated,
      isVideoSticker: msg.sticker.is_video,
      customEmojiId: msg.sticker.custom_emoji_id,
      fileSize: msg.sticker.file_size,
    }];
  }

  if (msg.animation) {
    return [{
      type: 'animation',
      fileId: msg.animation.file_id,
      fileUniqueId: msg.animation.file_unique_id,
      width: msg.animation.width,
      height: msg.animation.height,
      duration: msg.animation.duration,
      fileName: msg.animation.file_name,
      mimeType: msg.animation.mime_type,
      fileSize: msg.animation.file_size,
    }];
  }

  if (msg.video) {
    return [{
      type: 'video',
      fileId: msg.video.file_id,
      fileUniqueId: msg.video.file_unique_id,
      width: msg.video.width,
      height: msg.video.height,
      duration: msg.video.duration,
      fileName: msg.video.file_name,
      mimeType: msg.video.mime_type,
      fileSize: msg.video.file_size,
      hasSpoiler: spoiler,
    }];
  }

  if (msg.video_note) {
    return [{
      type: 'video_note',
      fileId: msg.video_note.file_id,
      fileUniqueId: msg.video_note.file_unique_id,
      width: msg.video_note.length,
      height: msg.video_note.length,
      duration: msg.video_note.duration,
      fileSize: msg.video_note.file_size,
    }];
  }

  if (msg.voice) {
    return [{
      type: 'voice',
      fileId: msg.voice.file_id,
      fileUniqueId: msg.voice.file_unique_id,
      duration: msg.voice.duration,
      mimeType: msg.voice.mime_type,
      fileSize: msg.voice.file_size,
    }];
  }

  if (msg.audio) {
    return [{
      type: 'audio',
      fileId: msg.audio.file_id,
      fileUniqueId: msg.audio.file_unique_id,
      duration: msg.audio.duration,
      fileName: msg.audio.file_name,
      mimeType: msg.audio.mime_type,
      fileSize: msg.audio.file_size,
    }];
  }

  if (msg.document) {
    return [{
      type: 'document',
      fileId: msg.document.file_id,
      fileUniqueId: msg.document.file_unique_id,
      fileName: msg.document.file_name,
      mimeType: msg.document.mime_type,
      fileSize: msg.document.file_size,
    }];
  }

  return undefined;
}

export function fromGrammyMessage(message: GrammyMessageInput): TelegramMessage {
  const sender: TelegramUser | undefined = message.from
    ? {
        id: String(message.from.id),
        firstName: message.from.first_name,
        lastName: message.from.last_name,
        username: message.from.username,
        isBot: message.from.is_bot,
        isPremium: message.from.is_premium ?? false,
      }
    : undefined;

  const textEntities = message.entities ?? message.caption_entities;
  const textContent = message.text ?? message.caption ?? '';

  return {
    messageId: message.message_id,
    chatId: String(message.chat.id),
    sender,
    date: message.date,
    editDate: message.edit_date,
    text: textContent,
    entities: convertGrammyEntities(textEntities),
    replyToMessageId: message.reply_to_message?.message_id,
    forwardInfo: convertGrammyForwardInfo(message.forward_origin),
    mediaGroupId: message.media_group_id,
    viaBotId: message.via_bot ? String(message.via_bot.id) : undefined,
    attachments: convertGrammyAttachments(message),
    source: 'bot',
  };
}

// --- dedup ---

export function createMessageDedup(maxSize = 10000) {
  const seen = new Set<string>();
  const queue: string[] = [];

  return {
    tryAdd(chatId: string, messageId: number): boolean {
      const key = `${chatId}:${messageId}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      queue.push(key);
      while (queue.length > maxSize) {
        const old = queue.shift()!;
        seen.delete(old);
      }
      return true;
    },
  };
}
