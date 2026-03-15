import { createPatch } from 'diff';

import type { CanonicalIMEvent } from './adaptation/types';
import { useLogger } from './config/logger';
import { createEmptyIC, reduce } from './projection';
import type { IntermediateContext } from './projection';
import { rcToXml, render } from './rendering';
import type { RenderedContext, RenderParams } from './rendering';

// Per-chat IC/RC state manager. Encapsulates the Projection → Rendering
// pipeline, debug dumping, and diff logging.
export const createPipeline = (renderParams: RenderParams) => {
  const logger = useLogger('pipeline');
  const renderLogger = useLogger('rendering');

  const sessions = new Map<string, IntermediateContext>();
  const renderedSessions = new Map<string, RenderedContext>();
  const cursors = new Map<string, number>();

  // Compute effective RenderParams for a chat, merging per-chat cursor with base params.
  const effectiveParams = (chatId: string): RenderParams => {
    const cursor = cursors.get(chatId);
    return cursor != null ? { ...renderParams, compactCursorMs: cursor } : renderParams;
  };

  const logRendering = (sessionId: string, oldRC: RenderedContext | undefined, newRC: RenderedContext) => {
    if (!oldRC) return; // Skip full RC log on cold start — too noisy
    const oldXml = rcToXml(oldRC);
    const newXml = rcToXml(newRC);
    if (oldXml === newXml) return;
    const patch = createPatch(`RC(${sessionId})`, oldXml, newXml, 'before', 'after', { context: 3 });
    renderLogger.log(`RC diff:\n${patch}`);
  };

  // Push a single canonical event through the pipeline: reduce IC → render RC → log diff.
  const pushEvent = (chatId: string, event: CanonicalIMEvent): RenderedContext => {
    const oldIC = sessions.get(chatId) ?? createEmptyIC(chatId);
    const newIC = reduce(oldIC, event);
    sessions.set(chatId, newIC);

    const oldRC = renderedSessions.get(chatId);
    const newRC = render(newIC, effectiveParams(chatId));
    renderedSessions.set(chatId, newRC);
    logRendering(chatId, oldRC, newRC);

    return newRC;
  };

  // Cold-start replay: rebuild IC from persisted events, then render RC.
  const replayChat = (chatId: string, events: CanonicalIMEvent[]): RenderedContext => {
    let ic = createEmptyIC(chatId);
    for (const event of events)
      ic = reduce(ic, event);
    sessions.set(chatId, ic);

    const rc = render(ic, effectiveParams(chatId));
    renderedSessions.set(chatId, rc);

    logger.withFields({ chatId, events: events.length, nodes: ic.nodes.length, users: ic.users.size }).log('Replayed session');
    return rc;
  };

  // Update compact cursor for a chat. Re-renders RC with the new cursor so
  // segments before the cursor are excluded.
  const setCompactCursor = (chatId: string, cursorMs: number): RenderedContext | undefined => {
    cursors.set(chatId, cursorMs);
    const ic = sessions.get(chatId);
    if (!ic) return;
    const oldRC = renderedSessions.get(chatId);
    const rc = render(ic, effectiveParams(chatId));
    renderedSessions.set(chatId, rc);
    logRendering(chatId, oldRC, rc);
    logger.withFields({ chatId, cursorMs }).log('Compact cursor updated');
    return rc;
  };

  const getCompactCursor = (chatId: string) => cursors.get(chatId);
  const getIC = (chatId: string) => sessions.get(chatId);
  const getRC = (chatId: string) => renderedSessions.get(chatId);
  const getChatIds = (): string[] => [...renderedSessions.keys()];

  return { pushEvent, replayChat, setCompactCursor, getCompactCursor, getIC, getRC, getChatIds };
};
