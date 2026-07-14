import { enableMapSet, produce } from 'immer';

import type { ICMessage, ICRuntimeEvent, ICSystemEvent, ICUserState, IntermediateContext } from './types';
import { contentToPlainText } from '../adaptation';
import type {
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalIMEvent,
  CanonicalMessageEvent,
  CanonicalServiceEvent,
} from '../adaptation/types';
import type { RuntimeEvent } from '../runtime-event';

export type PipelineEvent = CanonicalIMEvent | RuntimeEvent;

enableMapSet();

const findMessageIndex = (nodes: readonly { type: string; messageId?: string }[], messageId: string): number => {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    if (node.type === 'message' && node.messageId === messageId) return i;
  }
  return -1;
};

const REPLY_PREVIEW_MAX = 100;

const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  let sliced = text.slice(0, max);
  // Preserve UTF-16 surrogate pairs at the truncation boundary.
  if (sliced.length > 0 && (sliced.charCodeAt(sliced.length - 1) & 0xFC00) === 0xD800) {
    sliced = sliced.slice(0, -1);
  }
  return `${sliced}…`;
};

const reduceMessage = (draft: IntermediateContext, event: CanonicalMessageEvent) => {
  // Authoritative userbot echoes update synthetic payloads without moving local order.
  const existingIdx = findMessageIndex(draft.nodes, event.messageId);
  if (existingIdx !== -1) {
    const existing = draft.nodes[existingIdx] as ICMessage;
    if (event.isSelfSent) existing.isSelfSent = true;
    if (existing.isSelfSent && !event.isSelfSent) {
      existing.sender = event.sender;
      existing.timestampSec = event.timestampSec;
      existing.utcOffsetMin = event.utcOffsetMin;
      existing.content = event.content;
      existing.attachments = event.attachments;
      existing.replyToMessageId = event.replyToMessageId;
      existing.replyQuoteContent = event.replyQuoteContent;
      existing.forwardInfo = event.forwardInfo;
    }
    return;
  }

  if (event.sender) {
    const existing = draft.users.get(event.sender.id);

    if (existing && (
      existing.user.displayName !== event.sender.displayName
      || existing.user.username !== event.sender.username
    )) {
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
    if (event.replyQuoteContent && event.replyQuoteContent.length > 0) {
      message.replyQuoteContent = event.replyQuoteContent;
    }
    // Snapshot reply target's sender + preview from current IC state
    const targetIdx = findMessageIndex(draft.nodes, event.replyToMessageId);
    if (targetIdx !== -1) {
      const target = draft.nodes[targetIdx] as ICMessage;
      message.replyToSender = target.sender;
      const plain = contentToPlainText(target.content);
      if (plain) message.replyToPreview = truncate(plain, REPLY_PREVIEW_MAX);
      if (target.content.length > 0) message.replyToContent = target.content;
    }
  }
  if (event.forwardInfo) message.forwardInfo = event.forwardInfo;
  if (event.isSelfSent) message.isSelfSent = true;
  draft.nodes.push(message);

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

const reduceRuntime = (draft: IntermediateContext, event: RuntimeEvent) => {
  const node: ICRuntimeEvent = {
    type: 'runtime_event',
    kind: event.kind,
    receivedAtMs: event.receivedAtMs,
    timestampSec: event.timestampSec,
    utcOffsetMin: event.utcOffsetMin,
    taskId: event.taskId,
    taskType: event.taskType,
    intention: event.intention,
    finalSummary: event.finalSummary,
    hasFullOutput: event.hasFullOutput,
  };
  draft.nodes.push(node);
};

export const reduce = (ic: IntermediateContext, event: PipelineEvent): IntermediateContext =>
  produce(ic, draft => {
    switch (event.type) {
    case 'message': reduceMessage(draft, event); break;
    case 'edit': reduceEdit(draft, event); break;
    case 'delete': reduceDelete(draft, event); break;
    case 'service': reduceService(draft, event); break;
    case 'runtime': reduceRuntime(draft, event); break;
    }
  });
