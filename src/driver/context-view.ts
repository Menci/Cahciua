import type { RenderedContext, RenderedContextSegment } from './context-types';
import { contentToXml } from '../rendering';
import type { BaseRenderedContext } from '../rendering/types';

export interface ContextViewParams {
  cursorMs?: number;
  blockedUserIds?: ReadonlySet<string>;
}

// This is the conversion from reusable rendering records to Driver's model
// segments. Policy never rebuilds XML/images and no record metadata is spread.
export const selectContextView = (records: BaseRenderedContext, params: ContextViewParams): RenderedContext =>
  records.filter(record => params.cursorMs == null || record.metadata.receivedAtMs >= params.cursorMs)
    .map((record): RenderedContextSegment => {
      const receivedAtMs = record.metadata.receivedAtMs;
      if (record.kind !== 'message') {
        return {
          receivedAtMs, content: record.presentation.body,
          ...(record.kind === 'runtime' && { isRuntimeEvent: true }),
        };
      }
      const { sender, isSelfSent } = record.metadata;
      const { isMyself, mentionsMe, repliesToMe } = record.activation;
      const blocked = !!(sender?.id && params.blockedUserIds?.has(sender.id));
      return {
        receivedAtMs,
        content: blocked ? record.presentation.blocked : record.presentation.body,
        ...(sender?.id && { senderId: sender.id }),
        ...(isMyself && { isMyself: true }),
        ...(isSelfSent && { isSelfSent: true }),
        ...(!blocked && mentionsMe && { mentionsMe: true }),
        ...(!blocked && repliesToMe && { repliesToMe: true }),
      };
    });

export const rcToXml = (context: RenderedContext): string =>
  context.map(segment => contentToXml(segment.content)).join('\n');
