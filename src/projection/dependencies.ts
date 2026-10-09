import type { PipelineEvent } from './reduce';

// This contract mirrors every lookup performed by reduce. Consumers may supply
// a sparse IC containing these persisted targets; the reducer remains pure.
export const projectionDependencies = (event: PipelineEvent) => {
  const messageIds = event.type === 'message'
    ? [event.messageId, ...(event.replyToMessageId ? [event.replyToMessageId] : [])]
    : event.type === 'edit' ? [event.messageId]
      : event.type === 'delete' ? event.messageIds
        : event.type === 'service' && event.action.action === 'message_pinned' ? [event.action.messageId] : [];
  return {
    messageIds: [...new Set(messageIds)],
    userIds: event.type === 'message' && event.sender ? [event.sender.id] : [],
  };
};
