import type { RenderedContext, RenderedContextSegment, RenderedNode, RenderedNodes } from '../rendering/types';

export interface ContextViewParams {
  cursorMs?: number;
  blockedUserIds?: ReadonlySet<string>;
}

// Policy is a pure consumer of base records. It never rebuilds body XML/images.
export const selectContextView = (nodes: RenderedNodes, params: ContextViewParams): RenderedContext =>
  nodes.filter(node => params.cursorMs == null || node.receivedAtMs >= params.cursorMs)
    .map((node: RenderedNode) => {
      const segment: RenderedContextSegment = {
        receivedAtMs: node.receivedAtMs,
        content: node.content,
        ...(node.senderId && { senderId: node.senderId }),
        ...(node.isMyself && { isMyself: true }),
        ...(node.isSelfSent && { isSelfSent: true }),
        ...(node.mentionsMe && { mentionsMe: true }),
        ...(node.repliesToMe && { repliesToMe: true }),
        ...(node.isRuntimeEvent && { isRuntimeEvent: true }),
      };
      const { blockedContent } = node;
      if (!node.senderId || !params.blockedUserIds?.has(node.senderId)) return segment;
      if (!blockedContent) throw new Error('Missing blocked message representation');
      return { ...segment, content: blockedContent, mentionsMe: undefined, repliesToMe: undefined };
    });
