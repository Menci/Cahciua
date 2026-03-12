import type { Message as GrammyMessage } from '@grammyjs/types';

import type { Attachment, ForwardInfo, MessageEntity, TelegramMessage, TelegramUser } from './types';

// --- entity conversion ---

const convertGrammyEntities = (
  entities?: GrammyMessage['entities'],
): MessageEntity[] | undefined => {
  if (!entities || entities.length === 0) return undefined;
  return entities.map(e => ({
    type: e.type,
    offset: e.offset,
    length: e.length,
    url: 'url' in e ? e.url : undefined,
    language: 'language' in e ? e.language : undefined,
    customEmojiId: 'custom_emoji_id' in e ? e.custom_emoji_id : undefined,
    userId: 'user' in e ? String(e.user.id) : undefined,
  }));
};

// --- forward info ---

const convertGrammyForwardInfo = (
  origin?: GrammyMessage['forward_origin'],
): ForwardInfo | undefined => {
  if (!origin) return undefined;

  const info: ForwardInfo = { date: origin.date };

  switch (origin.type) {
  case 'user':
    info.fromUserId = String(origin.sender_user.id);
    break;
  case 'hidden_user':
    info.senderName = origin.sender_user_name;
    break;
  case 'chat':
    info.fromChatId = String(origin.sender_chat.id);
    break;
  case 'channel':
    info.fromChatId = String(origin.chat.id);
    if (origin.message_id) info.fromMessageId = origin.message_id;
    break;
  }

  return info;
};

// --- media → attachments ---

const convertGrammyAttachments = (msg: GrammyMessage): Attachment[] | undefined => {
  const spoiler = msg.has_media_spoiler;

  if (msg.photo) {
    const largest = msg.photo.toSorted((a, b) => b.width * b.height - a.width * a.height)[0];
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
};

// --- public API ---

export const fromGrammyMessage = (message: GrammyMessage): TelegramMessage => {
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
};
