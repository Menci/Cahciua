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
  replyToContent?: ContentNode[];
  forwardInfo?: CanonicalForwardInfo;
  attachments: CanonicalAttachment[];
  editedAtSec?: number;
  editUtcOffsetMin?: number;
  deleted?: boolean;
  isSelfSent?: boolean;
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

export interface ICMembersJoinedEvent {
  type: 'system_event';
  kind: 'members_joined';
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  actor?: CanonicalUser;
  members: CanonicalUser[];
}

export interface ICMemberLeftEvent {
  type: 'system_event';
  kind: 'member_left';
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  actor?: CanonicalUser;
  member: CanonicalUser;
}

export interface ICChatRenamedEvent {
  type: 'system_event';
  kind: 'chat_renamed';
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  actor?: CanonicalUser;
  oldTitle: string | null;
  newTitle: string;
}

export interface ICChatPhotoChangedEvent {
  type: 'system_event';
  kind: 'chat_photo_changed';
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  actor?: CanonicalUser;
}

export interface ICChatPhotoDeletedEvent {
  type: 'system_event';
  kind: 'chat_photo_deleted';
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  actor?: CanonicalUser;
}

export interface ICMessagePinnedEvent {
  type: 'system_event';
  kind: 'message_pinned';
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  actor?: CanonicalUser;
  messageId: string;
  preview?: string;
}

export type ICSystemEvent =
  | ICUserRenamedEvent
  | ICMembersJoinedEvent
  | ICMemberLeftEvent
  | ICChatRenamedEvent
  | ICChatPhotoChangedEvent
  | ICChatPhotoDeletedEvent
  | ICMessagePinnedEvent;

export interface ICRuntimeEvent {
  type: 'runtime_event';
  kind: 'task_completed';
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  taskId: number;
  taskType: string;
  intention?: string;
  finalSummary: string;
  hasFullOutput: boolean;
}

export type ICNode = ICMessage | ICSystemEvent | ICRuntimeEvent;

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
  chatTitle?: string;
}

export const createEmptyIC = (sessionId: string): IntermediateContext => ({
  sessionId,
  nodes: [],
  users: new Map(),
});
