import { enableMapSet, produce } from 'immer';

import type { ICMessage, ICSystemEvent, ICUserState, IntermediateContext } from './types';
import { contentToPlainText } from '../adaptation';
import type {
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalIMEvent,
  CanonicalMessageEvent,
  CanonicalServiceEvent,
  CanonicalUser,
} from '../adaptation/types';

enableMapSet();

const userChanged = (a: CanonicalUser, b: CanonicalUser): boolean =>
  a.displayName !== b.displayName || (a.username ?? null) !== (b.username ?? null);

const findMessageIndex = (nodes: readonly { type: string; messageId?: string }[], messageId: string): number => {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    if (node.type === 'message' && node.messageId === messageId) return i;
  }
  return -1;
};

const REPLY_PREVIEW_MAX = 100;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

const reduceMessage = (draft: IntermediateContext, event: CanonicalMessageEvent) => {
  // Dedup: skip if a message with the same ID already exists (bypass + userbot race).
  // Merge isSelfSent from the late-arriving synthetic event into the existing node.
  const existingIdx = findMessageIndex(draft.nodes, event.messageId);
  if (existingIdx !== -1) {
    if (event.isSelfSent)
      (draft.nodes[existingIdx] as ICMessage).isSelfSent = true;
    return;
  }

  // MetaReducer: detect user rename before appending the message
  if (event.sender) {
    const existing = draft.users.get(event.sender.id);

    if (existing && userChanged(existing.user, event.sender)) {
      const systemEvent: ICSystemEvent = {
        type: 'system_event',
        kind: 'user_renamed',
        receivedAtMs: event.receivedAtMs,
        timestampSec: event.timestampSec,
        utcOffsetMin: event.utcOffsetMin,
        userId: event.sender.id,
        oldUser: existing.user,
        newUser: event.sender,
      };
      draft.nodes.push(systemEvent);
    }
  }

  const message: ICMessage = {
    type: 'message',
    messageId: event.messageId,
    sender: event.sender,
    receivedAtMs: event.receivedAtMs,
    timestampSec: event.timestampSec,
    utcOffsetMin: event.utcOffsetMin,
    content: event.content,
    attachments: event.attachments,
  };
  if (event.replyToMessageId) {
    message.replyToMessageId = event.replyToMessageId;
    // Snapshot reply target's sender + preview from current IC state
    const targetIdx = findMessageIndex(draft.nodes, event.replyToMessageId);
    if (targetIdx !== -1) {
      const target = draft.nodes[targetIdx] as ICMessage;
      message.replyToSender = target.sender;
      const plain = contentToPlainText(target.content);
      if (plain) message.replyToPreview = truncate(plain, REPLY_PREVIEW_MAX);
    }
  }
  if (event.forwardInfo) message.forwardInfo = event.forwardInfo;
  if (event.isSelfSent) message.isSelfSent = true;
  draft.nodes.push(message);

  // Update user state
  if (event.sender) {
    const existing = draft.users.get(event.sender.id);
    if (existing) {
      existing.user = event.sender;
      existing.lastSeenAtMs = event.receivedAtMs;
      existing.messageCount++;
    } else {
      const state: ICUserState = {
        user: event.sender,
        firstSeenAtMs: event.receivedAtMs,
        lastSeenAtMs: event.receivedAtMs,
        messageCount: 1,
      };
      draft.users.set(event.sender.id, state);
    }
  }
};

const reduceEdit = (draft: IntermediateContext, event: CanonicalEditEvent) => {
  const idx = findMessageIndex(draft.nodes, event.messageId);
  if (idx === -1) return;

  const node = draft.nodes[idx] as ICMessage;
  node.content = event.content;
  node.attachments = event.attachments;
  node.editedAtSec = event.timestampSec;
  node.editUtcOffsetMin = event.utcOffsetMin;
};

const reduceDelete = (draft: IntermediateContext, event: CanonicalDeleteEvent) => {
  for (const messageId of event.messageIds) {
    const idx = findMessageIndex(draft.nodes, messageId);
    if (idx === -1) continue;
    (draft.nodes[idx] as ICMessage).deleted = true;
  }
};

const reduceService = (draft: IntermediateContext, event: CanonicalServiceEvent) => {
  const base = {
    type: 'system_event' as const,
    receivedAtMs: event.receivedAtMs,
    timestampSec: event.timestampSec,
    utcOffsetMin: event.utcOffsetMin,
    actor: event.actor,
  };

  const { action } = event;

  switch (action.action) {
  case 'members_joined':
    draft.nodes.push({ ...base, kind: 'members_joined', members: action.members });
    break;
  case 'member_left':
    draft.nodes.push({ ...base, kind: 'member_left', member: action.member });
    break;
  case 'chat_renamed': {
    const oldTitle = draft.chatTitle ?? null;
    draft.nodes.push({ ...base, kind: 'chat_renamed', oldTitle, newTitle: action.newTitle });
    draft.chatTitle = action.newTitle;
    break;
  }
  case 'chat_photo_changed':
    draft.nodes.push({ ...base, kind: 'chat_photo_changed' });
    break;
  case 'chat_photo_deleted':
    draft.nodes.push({ ...base, kind: 'chat_photo_deleted' });
    break;
  case 'message_pinned': {
    const targetIdx = findMessageIndex(draft.nodes, action.messageId);
    let preview: string | undefined;
    if (targetIdx !== -1) {
      const target = draft.nodes[targetIdx] as ICMessage;
      const plain = contentToPlainText(target.content);
      if (plain) preview = truncate(plain, REPLY_PREVIEW_MAX);
    }
    draft.nodes.push({ ...base, kind: 'message_pinned', messageId: action.messageId, preview });
    break;
  }
  }
};

export const reduce = (ic: IntermediateContext, event: CanonicalIMEvent): IntermediateContext =>
  produce(ic, draft => {
    switch (event.type) {
    case 'message': reduceMessage(draft, event); break;
    case 'edit': reduceEdit(draft, event); break;
    case 'delete': reduceDelete(draft, event); break;
    case 'service': reduceService(draft, event); break;
    }
  });
