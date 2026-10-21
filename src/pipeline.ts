import { createPatch } from 'diff';

import { useLogger } from './config/logger';
import { createEmptyIC, reduce } from './projection';
import type { PipelineEvent, IntermediateContext } from './projection';
import { createRenderer, isInRenderWindow, renderedRecordsToXml } from './rendering';
import type { BaseRenderedContext, RenderParams, RenderWindow } from './rendering';

export type { PipelineEvent } from './projection';

export const createPipeline = (renderParams: RenderParams) => {
  const logger = useLogger('pipeline');
  const renderLogger = useLogger('rendering');
  const sessions = new Map<string, IntermediateContext>();
  const renderedSessions = new Map<string, BaseRenderedContext>();
  const renderers = new Map<string, ReturnType<typeof createRenderer>>();
  const windows = new Map<string, RenderWindow>();

  const renderResident = (chatId: string, ic: IntermediateContext): BaseRenderedContext => {
    let renderer = renderers.get(chatId);
    if (!renderer) {
      renderer = createRenderer();
      renderers.set(chatId, renderer);
    }
    return renderer.render(ic, renderParams, windows.get(chatId));
  };

  const logRendering = (chatId: string, oldRC: BaseRenderedContext | undefined, newRC: BaseRenderedContext): void => {
    if (!oldRC) return;
    const oldXml = renderedRecordsToXml(oldRC);
    const newXml = renderedRecordsToXml(newRC);
    if (oldXml === newXml) return;
    const patch = createPatch(`RC(${chatId})`, oldXml, newXml, 'before', 'after', { context: 3 });
    renderLogger.log(`RC diff:\n${patch}`);
  };

  const pushEvent = (chatId: string, event: PipelineEvent): BaseRenderedContext => {
    const oldIC = sessions.get(chatId) ?? createEmptyIC(chatId);
    const newIC = reduce(oldIC, event);
    sessions.set(chatId, newIC);

    const oldRC = renderedSessions.get(chatId);
    const newRC = renderResident(chatId, newIC);
    renderedSessions.set(chatId, newRC);
    logRendering(chatId, oldRC, newRC);

    return newRC;
  };

  const replayChat = (chatId: string, events: PipelineEvent[]): BaseRenderedContext => {
    let ic = createEmptyIC(chatId);
    for (const event of events)
      ic = reduce(ic, event);
    sessions.set(chatId, ic);
    const rc = renderResident(chatId, ic);
    renderedSessions.set(chatId, rc);
    logger.withFields({ chatId, events: events.length, nodes: ic.nodes.length, users: ic.users.size }).log('Replayed session');
    return rc;
  };

  // Startup can seed a range before replay. Driver separately requires residency
  // when mapping a completed compaction to an online window.
  const setRenderWindow = (chatId: string, window: RenderWindow): void => {
    const snapshot = Object.freeze({ ...window });
    windows.set(chatId, snapshot);
    renderers.get(chatId)?.retainWindow(snapshot);
    // Keep the diff baseline inside residency: the next event should not diff
    // all compacted messages as deletions. Driver retains its own input snapshot.
    const rc = renderedSessions.get(chatId);
    if (rc) renderedSessions.set(chatId, Object.freeze(rc.filter(record => isInRenderWindow(record.metadata.receivedAtMs, snapshot))));
  };

  const getRenderWindow = (chatId: string) => windows.get(chatId);
  const getIC = (chatId: string) => sessions.get(chatId);
  const getRenderParams = (): RenderParams => renderParams;
  const getRenderedChats = (): Array<[string, BaseRenderedContext]> => [...renderedSessions.entries()];
  return { pushEvent, replayChat, setRenderWindow, getRenderWindow, getIC, getRenderParams, getRenderedChats };
};
