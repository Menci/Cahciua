import { mkdirSync, writeFileSync } from 'node:fs';

import { createPatch } from 'diff';

import type { CanonicalIMEvent } from './adaptation/types';
import { useLogger } from './config/logger';
import { createEmptyIC, reduce } from './projection';
import type { IntermediateContext } from './projection';
import { rcToXml, render } from './rendering';
import type { RenderedContext, RenderParams } from './rendering';

const DUMP_DIR = '/tmp/cahciua';
mkdirSync(DUMP_DIR, { recursive: true });

const icToJson = (ic: IntermediateContext): string =>
  JSON.stringify({
    sessionId: ic.sessionId,
    nodes: ic.nodes,
    users: Object.fromEntries(ic.users),
  }, null, 2);

// Per-chat IC/RC state manager. Encapsulates the Projection → Rendering
// pipeline, debug dumping, and diff logging.
export const createPipeline = (renderParams: RenderParams) => {
  const logger = useLogger('pipeline');
  const projLogger = useLogger('projection');
  const renderLogger = useLogger('rendering');

  const sessions = new Map<string, IntermediateContext>();
  const renderedSessions = new Map<string, RenderedContext>();

  const dumpIC = (ic: IntermediateContext) => {
    writeFileSync(`${DUMP_DIR}/${ic.sessionId}.ic.json`, icToJson(ic));
  };

  const dumpRC = (sessionId: string, rc: RenderedContext) => {
    writeFileSync(`${DUMP_DIR}/${sessionId}.rc.xml`, rcToXml(rc));
  };

  const logProjection = (oldIC: IntermediateContext, newIC: IntermediateContext) => {
    const oldStr = icToJson(oldIC);
    const newStr = icToJson(newIC);
    if (oldStr === newStr) return;
    const patch = createPatch(`IC(${newIC.sessionId})`, oldStr, newStr, 'before', 'after', { context: 3 });
    projLogger.log(`IC diff:\n${patch}`);
  };

  const logRendering = (sessionId: string, oldRC: RenderedContext | undefined, newRC: RenderedContext) => {
    const newXml = rcToXml(newRC);
    if (!oldRC) {
      renderLogger.log(`RC(${sessionId}) full:\n${newXml}`);
      return;
    }
    const oldXml = rcToXml(oldRC);
    if (oldXml === newXml) return;
    const patch = createPatch(`RC(${sessionId})`, oldXml, newXml, 'before', 'after', { context: 3 });
    renderLogger.log(`RC diff:\n${patch}`);
  };

  // Push a single canonical event through the pipeline: reduce IC → render RC → log → dump.
  const pushEvent = (chatId: string, event: CanonicalIMEvent): RenderedContext => {
    const oldIC = sessions.get(chatId) ?? createEmptyIC(chatId);
    const newIC = reduce(oldIC, event);
    sessions.set(chatId, newIC);
    logProjection(oldIC, newIC);
    dumpIC(newIC);

    const oldRC = renderedSessions.get(chatId);
    const newRC = render(newIC, renderParams);
    renderedSessions.set(chatId, newRC);
    logRendering(chatId, oldRC, newRC);
    dumpRC(chatId, newRC);

    return newRC;
  };

  // Cold-start replay: rebuild IC from persisted events, then render RC.
  const replayChat = (chatId: string, events: CanonicalIMEvent[]): RenderedContext => {
    let ic = createEmptyIC(chatId);
    for (const event of events)
      ic = reduce(ic, event);
    sessions.set(chatId, ic);
    dumpIC(ic);

    const rc = render(ic, renderParams);
    renderedSessions.set(chatId, rc);
    logRendering(chatId, undefined, rc);
    dumpRC(chatId, rc);

    logger.withFields({ chatId, events: events.length, nodes: ic.nodes.length, users: ic.users.size }).log('Replayed session');
    return rc;
  };

  const getIC = (chatId: string) => sessions.get(chatId);
  const getRC = (chatId: string) => renderedSessions.get(chatId);
  const getChatIds = (): string[] => [...renderedSessions.keys()];

  return { pushEvent, replayChat, getIC, getRC, getChatIds };
};
