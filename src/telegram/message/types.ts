// --- Platform types (shared by telegram layer and db schema for JSON columns) ---

export interface MessageEntity {
  type: string; // bold, italic, url, mention, code, pre, text_link, custom_emoji, etc.
  offset: number;
  length: number;
  url?: string;
  language?: string;
  customEmojiId?: string;
  userId?: string;

  // Resolved at ingress for custom_emoji entities. MTProto only returns the
  // document, so the pack id and title are looked up alongside the message and
  // stored here; downstream code never re-resolves.
  customEmojiSetId?: string;
  customEmojiSetName?: string;
  customEmojiFormat?: 'static' | 'animated' | 'video';
}

export interface ForwardInfo {
  fromUserId?: string;
  fromChatId?: string;
  fromMessageId?: number;
  sender?: TelegramUser;
  senderName?: string; // for hidden forwards (privacy-protected sender)
  date?: number;
}

export interface Attachment {
  type: 'photo' | 'sticker' | 'document' | 'video' | 'audio' | 'voice' | 'video_note' | 'animation';

  // Display metadata only. Re-downloading is keyed off (chatId, messageId);
  // MTProto file references expire, so no provider-local handle is kept here.
  fileName?: string;
  mimeType?: string;
  fileSize?: number;

  // Dimensions
  width?: number;
  height?: number;
  duration?: number;

  // Low-res thumbnail (WebP, ≤512px) for LLM context (~85 tokens)
  thumbnailWebp?: string;

  // Sticker-specific
  emoji?: string;
  // Sticker sets are addressed by an opaque numeric id plus an access hash.
  // The hash is needed to resolve the pack title at ingress and never leaves
  // the Telegram message layer.
  stickerSetId?: string;
  stickerSetAccessHash?: string;
  // Human-readable pack title, resolved from stickerSetId before entering the pipeline.
  stickerSetName?: string;
  isAnimatedSticker?: boolean;
  isVideoSticker?: boolean;
  customEmojiId?: string;

  // Spoiler
  hasSpoiler?: boolean;

  // Set by hydrateAttachments for animation-to-text cache key (not from Telegram API)
  animationHash?: string;
}

// --- Telegram message types ---

export interface TelegramUser {
  id: string;
  firstName: string;
  lastName?: string;
  username?: string;
  isBot: boolean;
  isPremium: boolean;
  /**
   * Account-scoped MTProto access hash for the identity that observed this
   * user. It is only valid for that identity, so it must stay tied to the
   * ingress message and never be reused by another client.
   */
  accessHash?: string;
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
  replyQuote?: { text: string; entities?: MessageEntity[] };
  forwardInfo?: ForwardInfo;
  mediaGroupId?: string;
  viaBotId?: string;
  attachments?: Attachment[];
  source: 'bot' | 'userbot';

  // Service message fields (mutually exclusive with regular text content)
  newChatMembers?: TelegramUser[];
  leftChatMember?: TelegramUser;
  newChatTitle?: string;
  newChatPhoto?: boolean;
  deleteChatPhoto?: boolean;
  pinnedMessage?: { messageId: number };

  // Captured at ingress time before any asynchronous transforms block the session.
  receivedAtMs?: number;
  utcOffsetMin?: number;
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
  receivedAtMs?: number;
  utcOffsetMin?: number;
}

export interface TelegramMessageDelete {
  messageIds: number[];
  chatId?: string;
  receivedAtMs?: number;
  utcOffsetMin?: number;
}
