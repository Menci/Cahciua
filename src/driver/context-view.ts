import type { RenderedContext, RenderedContextSegment, RenderedRecord, BaseRenderedContext } from '../rendering/types';

export interface ContextViewParams {
  cursorMs?: number;
  blockedUserIds?: ReadonlySet<string>;
}

// Policy is a pure consumer of base records. It never rebuilds body XML/images.
export const selectContextView = (context: BaseRenderedContext, params: ContextViewParams): RenderedContext =>
  context.filter(record => params.cursorMs == null || record.receivedAtMs >= params.cursorMs)
    .map((record: RenderedRecord) => {
      const segment: RenderedContextSegment = {
        receivedAtMs: record.receivedAtMs,
        content: record.content,
        ...(record.senderId && { senderId: record.senderId }),
        ...(record.isMyself && { isMyself: true }),
        ...(record.isSelfSent && { isSelfSent: true }),
        ...(record.mentionsMe && { mentionsMe: true }),
        ...(record.repliesToMe && { repliesToMe: true }),
        ...(record.isRuntimeEvent && { isRuntimeEvent: true }),
      };
      const { blockedContent } = record;
      if (!record.senderId || !params.blockedUserIds?.has(record.senderId)) return segment;
      if (!blockedContent) throw new Error('Missing blocked message representation');
      return { ...segment, content: blockedContent, mentionsMe: undefined, repliesToMe: undefined };
    });
