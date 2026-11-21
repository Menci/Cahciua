import { Api } from 'teleproto';

import type {
  Attachment,
  ExternalReplyInfo,
  ForwardInfo,
  MessageEntity,
  ReplyQuote,
  SharedContact,
  TelegramMessage,
  TelegramMessageDelete,
  TelegramMessageEdit,
  TelegramUser,
} from './types';

export type TeleprotoEntityMap = ReadonlyMap<string, unknown>;

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

const entityToTelegramSender = (entity: unknown, fallbackId: string): TelegramUser | undefined => {
  if (entity instanceof Api.User || entity instanceof Api.UserEmpty) return userToTelegramUser(entity);
  if (entity instanceof Api.Channel) {
    return {
      id: fallbackId,
      firstName: entity.title,
      ...(entity.username ? { username: entity.username } : {}),
      isBot: false,
      isPremium: false,
    };
  }
  if (entity instanceof Api.Chat) {
    return {
      id: fallbackId,
      firstName: entity.title,
      isBot: false,
      isPremium: false,
    };
  }
  return undefined;
};

export const resolveSender = (
  message: Api.Message | Api.MessageService,
  entities?: TeleprotoEntityMap,
): TelegramUser | undefined => {
  const sender = message.sender;
  if (sender instanceof Api.User || sender instanceof Api.UserEmpty) return userToTelegramUser(sender);
  if (sender instanceof Api.Chat || sender instanceof Api.Channel) {
    const id = peerIdString(message.fromId) ?? String(sender.id);
    return entityToTelegramSender(sender, id);
  }
  const fromKey = peerIdString(message.fromId);
  if (fromKey && entities) return entityToTelegramSender(entities.get(fromKey), fromKey);
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

const describeReplyMedia = (media: Api.TypeMessageMedia | undefined): string | undefined => {
  if (!media || media instanceof Api.MessageMediaEmpty) return undefined;
  if (media instanceof Api.MessageMediaPhoto) return 'photo';
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document;
    if (!(doc instanceof Api.Document)) return 'document';
    if (media.voice) return 'voice';
    if (media.round) return 'video_note';
    if (documentAttribute(doc, Api.DocumentAttributeSticker) || documentAttribute(doc, Api.DocumentAttributeCustomEmoji)) return 'sticker';
    if (documentAttribute(doc, Api.DocumentAttributeAnimated)) return 'animation';
    if (documentAttribute(doc, Api.DocumentAttributeAudio)) return 'audio';
    if (documentAttribute(doc, Api.DocumentAttributeVideo)) return 'video';
    return 'document';
  }
  if (media instanceof Api.MessageMediaContact) return 'contact';
  if (media instanceof Api.MessageMediaPoll) return 'poll';
  if (media instanceof Api.MessageMediaWebPage) return 'webpage';
  if (media instanceof Api.MessageMediaGiveaway || media instanceof Api.MessageMediaGiveawayResults) return 'giveaway';
  if (media instanceof Api.MessageMediaStory) return 'story';
  return undefined;
};

/**
 * A shared contact carries no text, so a message whose media is a contact used
 * to adapt into an empty body and reach the model as a bare empty element.
 * Keep the card's fields instead: the name and vCard are where solicitation
 * text goes, and the phone number is what makes the card actionable.
 */
const convertContact = (media: Api.MessageMediaContact): SharedContact => ({
  phoneNumber: media.phoneNumber,
  firstName: media.firstName,
  lastName: media.lastName,
  vcard: media.vcard,
  userId: String(media.userId),
});

const convertContent = (message: Api.Message): ContentResult => {
  const rawText = message.message !== '' ? message.message : (message.richText ?? '');
  const base = { text: rawText, entities: convertEntities(message.entities) };
  const media = convertMedia(message.media);
  return media ? { ...base, attachments: media.attachments } : base;
};

const populateOriginFromPeer = (
  info: ForwardInfo,
  peer: Api.TypePeer,
  entities: TeleprotoEntityMap | undefined,
  fallbackUser?: unknown,
): void => {
  const key = peerIdString(peer)!;
  const resolved = entities?.get(key) ?? fallbackUser;
  const sender = entityToTelegramSender(resolved, key);
  if (peer instanceof Api.PeerUser) {
    info.fromUserId = key;
    info.sender = sender ?? resolvePeerUser(peer);
  } else {
    info.fromChatId = key;
    if (sender) info.sender = sender;
  }
};

const convertForwardHeader = (
  header: Api.TypeMessageFwdHeader,
  entities: TeleprotoEntityMap | undefined,
  fallbackSender?: unknown,
): ForwardInfo => {
  const info: ForwardInfo = { date: header.date };
  if (header.fromId) populateOriginFromPeer(info, header.fromId, entities, fallbackSender);
  if (header.channelPost) info.fromMessageId = header.channelPost;
  if (header.fromName) info.senderName = header.fromName;
  else if (!info.sender && header.postAuthor) info.senderName = header.postAuthor;
  return info;
};

const convertForwardInfo = (message: Api.Message, entities: TeleprotoEntityMap | undefined): ForwardInfo | undefined => {
  if (!message.fwdFrom) return undefined;
  return convertForwardHeader(message.fwdFrom, entities, message.forward?.sender);
};

const convertReply = (
  replyTo: Api.TypeMessageReplyHeader | undefined,
  chatId: string,
  entities: TeleprotoEntityMap | undefined,
): {
  replyToMessageId?: number;
  replyToTopId?: number;
  replyQuote?: ReplyQuote;
  externalReply?: ExternalReplyInfo;
} => {
  if (!replyTo) return {};
  if (replyTo instanceof Api.MessageReplyStoryHeader) {
    const origin: ForwardInfo = {};
    populateOriginFromPeer(origin, replyTo.peer, entities);
    return { externalReply: { origin, mediaType: 'story' } };
  }

  const quote: ReplyQuote | undefined = replyTo.quoteText
    ? { text: replyTo.quoteText, entities: convertEntities(replyTo.quoteEntities) }
    : undefined;
  const replyPeerId = peerIdString(replyTo.replyToPeerId);
  const isExternal = replyTo.replyFrom != null || (replyPeerId != null && replyPeerId !== chatId);

  if (!isExternal) {
    return {
      ...(replyTo.replyToMsgId != null ? { replyToMessageId: replyTo.replyToMsgId } : {}),
      ...(replyTo.replyToTopId != null ? { replyToTopId: replyTo.replyToTopId } : {}),
      ...(quote ? { replyQuote: quote } : {}),
    };
  }

  // Cross-chat replies carry their source in `replyFrom` and/or an external
  // `replyToPeerId`; their message ID belongs to that external peer and must
  // never be exposed as an in-chat `replyToMessageId`.
  const origin: ForwardInfo = replyTo.replyFrom
    ? convertForwardHeader(replyTo.replyFrom, entities)
    : {};
  if (!origin.fromUserId && !origin.fromChatId && replyTo.replyToPeerId)
    populateOriginFromPeer(origin, replyTo.replyToPeerId, entities);
  if (origin.fromMessageId == null && replyTo.replyToMsgId != null)
    origin.fromMessageId = replyTo.replyToMsgId;

  const mediaType = describeReplyMedia(replyTo.replyMedia);
  return {
    externalReply: {
      origin,
      ...(quote ? { quote } : {}),
      ...(mediaType ? { mediaType } : {}),
    },
  };
};

const serviceMessage = (
  message: Api.MessageService,
  source: TelegramMessage['source'],
  entities: TeleprotoEntityMap | undefined,
): TelegramMessage | null => {
  const base = {
    messageId: message.id,
    chatId: peerIdString(message.peerId)!,
    sender: resolveSender(message, entities) ?? { id: '0', firstName: '', isBot: false, isPremium: false },
    date: message.date,
    text: '',
    source,
  };
  const action = message.action;
  if (action instanceof Api.MessageActionChatAddUser) {
    return {
      ...base,
      newChatMembers: action.users.map(id => entityToTelegramSender(entities?.get(String(id)), String(id)) ?? { id: String(id), firstName: '', isBot: false, isPremium: false }),
    };
  }
  if (action instanceof Api.MessageActionChatJoinedByLink || action instanceof Api.MessageActionChatJoinedByRequest) {
    return { ...base, newChatMembers: [base.sender] };
  }
  if (action instanceof Api.MessageActionChatDeleteUser) {
    return { ...base, leftChatMember: entityToTelegramSender(entities?.get(String(action.userId)), String(action.userId)) ?? { id: String(action.userId), firstName: '', isBot: false, isPremium: false } };
  }
  if (action instanceof Api.MessageActionChatEditTitle) return { ...base, newChatTitle: action.title };
  if (action instanceof Api.MessageActionChatEditPhoto) return { ...base, newChatPhoto: true };
  if (action instanceof Api.MessageActionChatDeletePhoto) return { ...base, deleteChatPhoto: true };
  if (action instanceof Api.MessageActionPinMessage) {
    const pinnedId = message.replyTo instanceof Api.MessageReplyHeader ? (message.replyTo.replyToMsgId ?? 0) : 0;
    return { ...base, pinnedMessage: { messageId: pinnedId } };
  }
  return null;
};

/**
 * Live `NewMessage` updates attach the MTProto entity map to the outer event
 * while leaving `message._entities` empty; `getMessages` populates
 * `message._entities` directly. Merge both so peer titles and usernames resolve
 * regardless of ingress path.
 */
const effectiveEntities = (
  message: Api.Message | Api.MessageService,
  eventEntities?: TeleprotoEntityMap,
): TeleprotoEntityMap | undefined =>
  eventEntities && eventEntities.size > 0 ? eventEntities : message._entities;

export const fromTeleprotoMessage = (
  message: Api.Message | Api.MessageService,
  source: TelegramMessage['source'],
  eventEntities?: TeleprotoEntityMap,
): TelegramMessage | null => {
  const entities = effectiveEntities(message, eventEntities);
  if (message instanceof Api.MessageService) return serviceMessage(message, source, entities);
  if (!(message instanceof Api.Message)) return null;
  const chatId = peerIdString(message.peerId)!;
  const content = convertContent(message);
  const reply = convertReply(message.replyTo, chatId, entities);
  return {
    messageId: message.id,
    chatId,
    sender: resolveSender(message, entities) ?? { id: '0', firstName: '', isBot: false, isPremium: false },
    date: message.date,
    editDate: message.editDate,
    text: content.text,
    entities: content.entities,
    attachments: content.attachments,
    ...reply,
    forwardInfo: convertForwardInfo(message, entities),
    mediaGroupId: message.groupedId?.toString(),
    viaBotId: message.viaBotId == null ? undefined : String(message.viaBotId),
    ...message.media instanceof Api.MessageMediaContact
      ? { contact: convertContact(message.media) }
      : {},
    source,
  };
};

export const fromTeleprotoEdit = (
  message: Api.Message,
  eventEntities?: TeleprotoEntityMap,
): TelegramMessageEdit | null => {
  if (!(message instanceof Api.Message) || !message.editDate) return null;
  const entities = effectiveEntities(message, eventEntities);
  const content = convertContent(message);
  return {
    messageId: message.id,
    chatId: peerIdString(message.peerId)!,
    sender: resolveSender(message, entities),
    date: message.date,
    editDate: message.editDate,
    text: content.text,
    entities: content.entities,
    attachments: content.attachments,
    ...message.media instanceof Api.MessageMediaContact
      ? { contact: convertContact(message.media) }
      : {},
  };
};

export const fromTeleprotoDelete = (chatId: string | number, messageIds: ReadonlyArray<number>): TelegramMessageDelete => ({
  messageIds: [...messageIds],
  chatId: String(chatId),
});
