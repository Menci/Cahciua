import type { CanonicalAttachment, CanonicalUser } from '../adaptation/types';

export interface ICMessage {
  messageId: string;
  sender: CanonicalUser;
  timestamp: number;
  text?: string;
  replyToMessageId?: string;
  attachments: CanonicalAttachment[];
}

export interface ICUserState {
  user: CanonicalUser;
  firstSeenAt: number;
  lastSeenAt: number;
  messageCount: number;
}

export interface IntermediateContext {
  chatId: string;
  messages: ICMessage[];
  users: Map<string, ICUserState>;
  epoch: number;
  compactCursor: number;
}

export function createEmptyIC(chatId: string): IntermediateContext {
  return {
    chatId,
    messages: [],
    users: new Map(),
    epoch: 0,
    compactCursor: 0,
  };
}
