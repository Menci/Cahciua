export interface CanonicalUser {
  id: string;
  displayName: string;
  username?: string;
  isBot: boolean;
}

export interface CanonicalMessage {
  type: 'message';
  messageId: string;
  chatId: string;
  sender: CanonicalUser;
  timestamp: number;
  text?: string;
  replyToMessageId?: string;
  attachments: CanonicalAttachment[];
}

export interface CanonicalAttachment {
  type: 'photo' | 'sticker' | 'document' | 'video' | 'audio' | 'voice';
  thumbnail?: string;
  altText?: string;
  fileName?: string;
  mimeType?: string;
}

export type CanonicalEvent =
  | CanonicalMessage;
