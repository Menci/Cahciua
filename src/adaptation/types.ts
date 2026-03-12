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

// Rich text content tree — platform-agnostic representation parsed from
// platform-specific encodings (e.g. Telegram's text + offset-based entities).
// Adaptation parses the encoding; Rendering serializes the tree.
export type ContentNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'pre'; text: string; language?: string }
  | { type: 'bold'; children: ContentNode[] }
  | { type: 'italic'; children: ContentNode[] }
  | { type: 'underline'; children: ContentNode[] }
  | { type: 'strikethrough'; children: ContentNode[] }
  | { type: 'spoiler'; children: ContentNode[] }
  | { type: 'blockquote'; children: ContentNode[] }
  | { type: 'link'; url: string; children: ContentNode[] }
  | { type: 'mention'; userId?: string; children: ContentNode[] }
  | { type: 'custom_emoji'; customEmojiId: string; children: ContentNode[] };

export interface CanonicalForwardInfo {
  fromUserId?: string;
  fromChatId?: string;
  senderName?: string;
  date?: number;
}

export interface CanonicalMessageEvent {
  type: 'message';
  chatId: string;
  messageId: string;
  sender?: CanonicalUser;
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  content: ContentNode[];
  replyToMessageId?: string;
  forwardInfo?: CanonicalForwardInfo;
  attachments: CanonicalAttachment[];
}

export interface CanonicalEditEvent {
  type: 'edit';
  chatId: string;
  messageId: string;
  sender?: CanonicalUser;
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  content: ContentNode[];
  attachments: CanonicalAttachment[];
}

export interface CanonicalDeleteEvent {
  type: 'delete';
  chatId: string;
  messageIds: string[];
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
}

export type CanonicalIMEvent =
  | CanonicalMessageEvent
  | CanonicalEditEvent
  | CanonicalDeleteEvent;
