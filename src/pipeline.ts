import { createPatch } from 'diff';

import { useLogger } from './config/logger';
import { createEmptyIC, reduce } from './projection';
import type { PipelineEvent, IntermediateContext } from './projection';
import { createRenderer, rcToXml } from './rendering';
import type { RenderedNodes, RenderParams } from './rendering';

export type { PipelineEvent } from './projection';

export const createPipeline = (renderParams: RenderParams) => {
  const logger = useLogger('pipeline');
  const renderLogger = useLogger('rendering');
  const sessions = new Map<string, IntermediateContext>();
  const renderedSessions = new Map<string, RenderedNodes>();
  const renderers = new Map<string, ReturnType<typeof createRenderer>>();
  const cursors = new Map<string, number>();

  const renderResident = (chatId: string, ic: IntermediateContext): RenderedNodes => {
    let renderer = renderers.get(chatId);
    if (!renderer) {
      renderer = createRenderer();
      renderers.set(chatId, renderer);
    }
    const cursor = cursors.get(chatId);
    // Select residency before construction: old IC remains available for reply
    // snapshots, but messages outside the active window need no XML or Sharp.
    return renderer.render({ ...ic, nodes: ic.nodes.filter(node => cursor == null || node.receivedAtMs >= cursor) }, renderParams);
  };

  const logRendering = (chatId: string, oldRC: RenderedNodes | undefined, newRC: RenderedNodes): void => {
    if (!oldRC) return;
    const oldXml = rcToXml(oldRC);
    const newXml = rcToXml(newRC);
    if (oldXml === newXml) return;
    renderLogger.log(`RC diff:\n${createPatch(`RC(${chatId})`, oldXml, newXml, 'before', 'after', { context: 3 })}`);
  };

  const pushEvent = (chatId: string, event: PipelineEvent): RenderedNodes => {
    const ic = reduce(sessions.get(chatId) ?? createEmptyIC(chatId), event);
    sessions.set(chatId, ic);
    const rc = renderResident(chatId, ic);
    logRendering(chatId, renderedSessions.get(chatId), rc);
    renderedSessions.set(chatId, rc);
    return rc;
  };

  const replayChat = (chatId: string, events: PipelineEvent[]): RenderedNodes => {
    let ic = createEmptyIC(chatId);
    for (const event of events) ic = reduce(ic, event);
    sessions.set(chatId, ic);
    const rc = renderResident(chatId, ic);
    renderedSessions.set(chatId, rc);
    logger.withFields({ chatId, events: events.length, nodes: ic.nodes.length, users: ic.users.size }).log('Replayed session');
    return rc;
  };

  const setCompactCursor = (chatId: string, cursorMs: number): void => {
    cursors.set(chatId, cursorMs);
    renderers.get(chatId)?.retainAfter(cursorMs);
    const rc = renderedSessions.get(chatId);
    if (rc) renderedSessions.set(chatId, rc.filter(node => node.receivedAtMs >= cursorMs));
  };

  const getCompactCursor = (chatId: string) => cursors.get(chatId);
  const getIC = (chatId: string) => sessions.get(chatId);
  const getRenderParams = (): RenderParams => renderParams;
  const getRenderedChats = (): Array<[string, RenderedNodes]> => [...renderedSessions.entries()];
  return { pushEvent, replayChat, setCompactCursor, getCompactCursor, getIC, getRenderParams, getRenderedChats };
};
