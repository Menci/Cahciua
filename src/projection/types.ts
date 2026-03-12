import type { CanonicalAttachment, CanonicalForwardInfo, CanonicalUser, ContentNode } from '../adaptation/types';

export interface ICMessage {
  type: 'message';
  messageId: string;
  sender?: CanonicalUser;
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  content: ContentNode[];
  replyToMessageId?: string;
  replyToSender?: CanonicalUser;
  replyToPreview?: string;
  forwardInfo?: CanonicalForwardInfo;
  attachments: CanonicalAttachment[];
  editedAtSec?: number;
  editUtcOffsetMin?: number;
  deleted?: boolean;
}

export interface ICUserRenamedEvent {
  type: 'system_event';
  kind: 'user_renamed';
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  userId: string;
  oldUser: CanonicalUser;
  newUser: CanonicalUser;
}

// Extensible: add more event kinds (join/leave, etc.) to this union as needed.
export type ICSystemEvent = ICUserRenamedEvent;

export type ICNode = ICMessage | ICSystemEvent;

export interface ICUserState {
  user: CanonicalUser;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  messageCount: number;
}

export interface IntermediateContext {
  sessionId: string;
  nodes: ICNode[];
  users: Map<string, ICUserState>;
}

export const createEmptyIC = (sessionId: string): IntermediateContext => ({
  sessionId,
  nodes: [],
  users: new Map(),
});
