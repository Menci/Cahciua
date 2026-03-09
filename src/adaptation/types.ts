export interface CanonicalUser {
  id: string;
  displayName: string;
  username?: string;
  isBot: boolean;
}

export interface CanonicalAttachment {
  type: 'photo' | 'sticker' | 'animation' | 'video' | 'video_note' | 'audio' | 'voice' | 'document';
  mimeType?: string;
  fileName?: string;
  width?: number;
  height?: number;
  duration?: number;
  thumbnail?: string;
}

export interface CanonicalEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
  userId?: string;
  customEmojiId?: string;
}

export interface CanonicalForwardInfo {
  fromUserId?: string;
  fromChatId?: string;
  senderName?: string;
  date?: number;
}

export interface CanonicalMessageEvent {
  type: 'message';
  chatId: string;
  messageId: number;
  sender?: CanonicalUser;
  timestamp: number;
  text: string;
  entities?: CanonicalEntity[];
  replyToMessageId?: number;
  forwardInfo?: CanonicalForwardInfo;
  attachments: CanonicalAttachment[];
}

export interface CanonicalEditEvent {
  type: 'edit';
  chatId: string;
  messageId: number;
  sender?: CanonicalUser;
  timestamp: number;
  text: string;
  entities?: CanonicalEntity[];
  attachments: CanonicalAttachment[];
}

export interface CanonicalDeleteEvent {
  type: 'delete';
  chatId?: string;
  messageIds: number[];
  timestamp: number;
}

export type CanonicalEvent =
  | CanonicalMessageEvent
  | CanonicalEditEvent
  | CanonicalDeleteEvent;
