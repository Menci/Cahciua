import { selectContextView } from './context-view';
import type { ContextViewParams } from './context-view';
import { createEmptyIC, reduce } from '../projection';
import type { PipelineEvent } from '../projection';
import { rcToXml, render } from '../rendering';
import type { RenderParams } from '../rendering';

/**
 * Rebuild an IntermediateContext from persisted events and render it with the
 * canonical chatlog formatter — the exact same formatter used for the live
 * context, so historical messages come back in the format the model already
 * understands.
 *
 * `events` must already be scoped to a single chat: the caller is responsible
 * for loading them with a chat-scoped query. This function never widens the
 * scope.
 */
export const renderOldMessagesXml = (
  sessionId: string,
  events: PipelineEvent[],
  renderParams: RenderParams,
  viewParams: ContextViewParams = {},
): string => {
  let ic = createEmptyIC(sessionId);
  for (const event of events)
    ic = reduce(ic, event);
  return rcToXml(selectContextView(render(ic, renderParams), viewParams));
};
