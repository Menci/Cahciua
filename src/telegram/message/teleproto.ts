import { Api } from 'teleproto';

import type { Attachment, ForwardInfo, MessageEntity, TelegramMessage, TelegramMessageDelete, TelegramMessageEdit, TelegramUser } from './types';

export const chatIdToString = (id: number | string): string => String(id);

const peerIdString = (peer: Api.TypePeer | undefined): string | undefined => {
  if (!peer) return undefined;
  if (peer instanceof Api.PeerUser) return String(peer.userId);
  if (peer instanceof Api.PeerChat) return `-${peer.chatId}`;
  return `-100${peer.channelId}`;
};

const userToTelegramUser = (user: Api.User | Api.UserEmpty | undefined): TelegramUser | undefined => {
  if (!user) return undefined;
  const name = user instanceof Api.User ? user.username : undefined;
  return {
    id: String(user.id),
    firstName: user instanceof Api.User ? user.firstName ?? '' : '',
    lastName: user instanceof Api.User ? (user.lastName ?? undefined) : undefined,
    username: name,
    isBot: user instanceof Api.User && user.bot === true,
    isPremium: user instanceof Api.User && user.premium === true,
    accessHash: user instanceof Api.User && user.accessHash != null ? String(user.accessHash) : undefined,
  };
};

export const resolveSender = (message: Api.Message | Api.MessageService): TelegramUser | undefined => {
  const sender = message.sender;
  if (sender instanceof Api.User || sender instanceof Api.UserEmpty) return userToTelegramUser(sender);
  if (sender instanceof Api.Chat || sender instanceof Api.Channel) {
    return {
      id: peerIdString(message.fromId) ?? String(sender.id),
      firstName: sender.title,
      isBot: false,
      isPremium: false,
    };
  }
  return undefined;
};

const resolvePeerUser = (peer: Api.TypePeer | undefined): TelegramUser | undefined => {
  if (peer instanceof Api.PeerUser) return { id: String(peer.userId), firstName: '', isBot: false, isPremium: false };
  return undefined;
};

const ENTITY_TYPES = new Map<string, string>([
  ['MessageEntityBold', 'bold'],
  ['MessageEntityItalic', 'italic'],
  ['MessageEntityUnderline', 'underline'],
  ['MessageEntityStrike', 'strikethrough'],
  ['MessageEntitySpoiler', 'spoiler'],
  ['MessageEntityBlockquote', 'blockquote'],
  ['MessageEntityCode', 'code'],
  ['MessageEntityPre', 'pre'],
  ['MessageEntityMention', 'mention'],
  ['MessageEntityHashtag', 'hashtag'],
  ['MessageEntityCashtag', 'cashtag'],
  ['MessageEntityBotCommand', 'bot_command'],
  ['MessageEntityUrl', 'url'],
  ['MessageEntityEmail', 'email'],
  ['MessageEntityPhone', 'phone_number'],
  ['MessageEntityBankCard', 'bank_card'],
  ['MessageEntityTextUrl', 'text_link'],
  ['MessageEntityMentionName', 'text_mention'],
  ['MessageEntityCustomEmoji', 'custom_emoji'],
]);

export const convertEntities = (entities: Api.TypeMessageEntity[] | undefined): MessageEntity[] | undefined => {
  if (!entities || entities.length === 0) return undefined;
  return entities.map(entity => {
    const result: MessageEntity = {
      type: ENTITY_TYPES.get(entity.className) ?? entity.className,
      offset: entity.offset,
      length: entity.length,
    };
    if (entity instanceof Api.MessageEntityTextUrl) result.url = entity.url;
    if (entity instanceof Api.MessageEntityPre && entity.language) result.language = entity.language;
    if (entity instanceof Api.MessageEntityMentionName) result.userId = String(entity.userId);
    if (entity instanceof Api.MessageEntityCustomEmoji) result.customEmojiId = String(entity.documentId);
    return result;
  });
};

const photoToAttachment = (media: Api.MessageMediaPhoto): Attachment => {
  const photo = media.photo;
  if (!(photo instanceof Api.Photo)) throw new Error('Photo media has no photo');
  const sizes = photo.sizes.flatMap(size => size instanceof Api.PhotoSize ? [size] : []);
  const largest = sizes.sort((a, b) => b.w * b.h - a.w * a.h)[0];
  return {
    type: 'photo',
    ...(largest ? { width: largest.w, height: largest.h, fileSize: largest.size } : {}),
    ...(media.spoiler ? { hasSpoiler: true } : {}),
  };
};

const documentAttribute = <T extends Api.TypeDocumentAttribute>(document: Api.Document, type: new (...args: never[]) => T): T | undefined =>
  document.attributes.find((attribute): attribute is T => attribute instanceof type);

const documentToAttachment = (media: Api.MessageMediaDocument): Attachment => {
  const document = media.document;
  if (!(document instanceof Api.Document)) throw new Error('Document media has no document');
  const filename = documentAttribute(document, Api.DocumentAttributeFilename)?.fileName;
  const mimeType = document.mimeType === '' ? undefined : document.mimeType;
  const base = {
    fileName: filename,
    mimeType,
    fileSize: Number(document.size),
    ...(media.spoiler ? { hasSpoiler: true } : {}),
  };
  if (media.voice) {
    return { type: 'voice', duration: Math.round(documentAttribute(document, Api.DocumentAttributeAudio)?.duration ?? 0), ...base };
  }
  if (media.round) {
    const video = documentAttribute(document, Api.DocumentAttributeVideo);
    return {
      type: 'video_note',
      width: video?.w ?? 0,
      height: video?.h ?? 0,
      duration: Math.round(video?.duration ?? 0),
      ...base,
    };
  }
  const sticker = documentAttribute(document, Api.DocumentAttributeSticker);
  const customEmoji = documentAttribute(document, Api.DocumentAttributeCustomEmoji);
  if (sticker || customEmoji) {
    const video = documentAttribute(document, Api.DocumentAttributeVideo);
    const stickerSet = sticker?.stickerset ?? customEmoji?.stickerset;
    return {
      type: 'sticker',
      ...(video ? { width: video.w, height: video.h } : {}),
      emoji: sticker?.alt ?? customEmoji?.alt,
      isAnimatedSticker: mimeType === 'application/x-tgsticker',
      isVideoSticker: mimeType === 'video/webm',
      ...(stickerSet instanceof Api.InputStickerSetID
        ? { stickerSetId: String(stickerSet.id), stickerSetAccessHash: String(stickerSet.accessHash) }
        : {}),
      ...(customEmoji ? { customEmojiId: String(document.id) } : {}),
      ...base,
    };
  }
  if (documentAttribute(document, Api.DocumentAttributeAnimated)) {
    const video = documentAttribute(document, Api.DocumentAttributeVideo);
    return { type: 'animation', width: video?.w, height: video?.h, duration: Math.round(video?.duration ?? 0), ...base };
  }
  if (documentAttribute(document, Api.DocumentAttributeAudio)) {
    const audio = documentAttribute(document, Api.DocumentAttributeAudio)!;
    return { type: 'audio', duration: Math.round(audio.duration), ...base };
  }
  const video = documentAttribute(document, Api.DocumentAttributeVideo);
  if (video) return { type: 'video', width: video.w, height: video.h, duration: Math.round(video.duration), ...base };
  return { type: 'document', ...base };
};

interface ContentResult {
  text: string;
  entities?: MessageEntity[];
  attachments?: Attachment[];
}

const convertMedia = (media: Api.TypeMessageMedia | undefined): ContentResult | undefined => {
  if (!media) return undefined;
  if (media instanceof Api.MessageMediaPhoto) return { text: '', attachments: [photoToAttachment(media)] };
  if (media instanceof Api.MessageMediaDocument) return { text: '', attachments: [documentToAttachment(media)] };
  return undefined;
};

const convertContent = (message: Api.Message): ContentResult => {
  const rawText = message.message !== '' ? message.message : (message.richText ?? '');
  const base = { text: rawText, entities: convertEntities(message.entities) };
  const media = convertMedia(message.media);
  return media ? { ...base, attachments: media.attachments } : base;
};

const convertForwardInfo = (message: Api.Message): ForwardInfo | undefined => {
  const header = message.fwdFrom;
  if (!header) return undefined;
  const info: ForwardInfo = { date: header.date };
  const from = header.fromId;
  if (from instanceof Api.PeerUser) {
    info.fromUserId = String(from.userId);
    // The header only carries a peer id. The full entity lives on the
    // message-level `forward` view, which is what lets the rendered
    // `forwarded_from` show a name instead of a bare id.
    const forwardedSender = message.forward?.sender;
    info.sender = (forwardedSender instanceof Api.User || forwardedSender instanceof Api.UserEmpty)
      ? userToTelegramUser(forwardedSender)
      : resolvePeerUser(from);
  } else if (from instanceof Api.PeerChat) {
    info.fromChatId = `-${from.chatId}`;
  } else if (from instanceof Api.PeerChannel) {
    info.fromChatId = `-100${from.channelId}`;
    if (header.channelPost) info.fromMessageId = header.channelPost;
  }
  if (header.fromName) info.senderName = header.fromName;
  return info;
};

const entityToTelegramUser = (entity: Api.TypeUser | Api.TypeChat | undefined, id: string): TelegramUser | undefined => {
  if (entity instanceof Api.User || entity instanceof Api.UserEmpty) return userToTelegramUser(entity);
  if (entity instanceof Api.Chat) return { id, firstName: entity.title, isBot: false, isPremium: false };
  return undefined;
};

const serviceMessage = (message: Api.MessageService, source: TelegramMessage['source']): TelegramMessage | null => {
  const entities = message._entities;
  const base = {
    messageId: message.id,
    chatId: peerIdString(message.peerId)!,
    sender: resolveSender(message) ?? { id: '0', firstName: '', isBot: false, isPremium: false },
    date: message.date,
    text: '',
    source,
  };
  const action = message.action;
  if (action instanceof Api.MessageActionChatAddUser) {
    return {
      ...base,
      newChatMembers: action.users.map(id => entityToTelegramUser(entities?.get(String(id)), String(id)) ?? { id: String(id), firstName: '', isBot: false, isPremium: false }),
    };
  }
  if (action instanceof Api.MessageActionChatJoinedByLink || action instanceof Api.MessageActionChatJoinedByRequest) {
    return { ...base, newChatMembers: [base.sender] };
  }
  if (action instanceof Api.MessageActionChatDeleteUser) {
    return { ...base, leftChatMember: entityToTelegramUser(entities?.get(String(action.userId)), String(action.userId)) ?? { id: String(action.userId), firstName: '', isBot: false, isPremium: false } };
  }
  if (action instanceof Api.MessageActionChatEditTitle) return { ...base, newChatTitle: action.title };
  if (action instanceof Api.MessageActionChatEditPhoto) return { ...base, newChatPhoto: true };
  if (action instanceof Api.MessageActionChatDeletePhoto) return { ...base, deleteChatPhoto: true };
  if (action instanceof Api.MessageActionPinMessage) return { ...base, pinnedMessage: { messageId: message.replyTo?.replyToMsgId ?? 0 } };
  return null;
};

export const fromTeleprotoMessage = (
  message: Api.Message | Api.MessageService,
  source: TelegramMessage['source'],
): TelegramMessage | null => {
  if (message instanceof Api.MessageService) return serviceMessage(message, source);
  if (!(message instanceof Api.Message)) return null;
  const content = convertContent(message);
  return {
    messageId: message.id,
    chatId: peerIdString(message.peerId)!,
    sender: resolveSender(message) ?? { id: '0', firstName: '', isBot: false, isPremium: false },
    date: message.date,
    editDate: message.editDate,
    text: content.text,
    entities: content.entities,
    attachments: content.attachments,
    replyToMessageId: message.replyTo?.replyToMsgId,
    replyQuote: message.replyTo?.quoteText
      ? { text: message.replyTo.quoteText, entities: convertEntities(message.replyTo.quoteEntities) }
      : undefined,
    forwardInfo: convertForwardInfo(message),
    mediaGroupId: message.groupedId?.toString(),
    viaBotId: message.viaBotId == null ? undefined : String(message.viaBotId),
    source,
  };
};

export const fromTeleprotoEdit = (message: Api.Message): TelegramMessageEdit | null => {
  if (!(message instanceof Api.Message) || !message.editDate) return null;
  const content = convertContent(message);
  return {
    messageId: message.id,
    chatId: peerIdString(message.peerId)!,
    sender: resolveSender(message),
    date: message.date,
    editDate: message.editDate,
    text: content.text,
    entities: content.entities,
    attachments: content.attachments,
  };
};

export const fromTeleprotoDelete = (chatId: string | number, messageIds: ReadonlyArray<number>): TelegramMessageDelete => ({
  messageIds: [...messageIds],
  chatId: String(chatId),
});
