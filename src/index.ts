import { mkdirSync, writeFileSync } from 'node:fs';

import { createPatch } from 'diff';

import { adaptDelete, adaptEdit, adaptMessage, captureUtcOffset, contentToPlainText, parseContent } from './adaptation';
import type { CanonicalMessageEvent } from './adaptation';
import { loadConfig } from './config/config';
import { setupLogger, useLogger } from './config/logger';
import { createDatabase, loadEvents, loadKnownChatIds, loadLatestMessageContent, lookupChatId, persistEvent, persistMessage, persistMessageDelete, persistMessageEdit, runMigrations } from './db';
import { createDriver } from './driver';
import { createEmptyIC, reduce } from './projection';
import type { IntermediateContext } from './projection';
import { rcToXml, render } from './rendering';
import type { RenderedContext, RenderParams } from './rendering';
import { createTelegramManager } from './telegram';
import { loadSession } from './telegram/session';

setupLogger();

const logger = useLogger('cahciua');
const projLogger = useLogger('projection');
const renderLogger = useLogger('rendering');

const DUMP_DIR = '/tmp/cahciua';
mkdirSync(DUMP_DIR, { recursive: true });

const icToJson = (ic: IntermediateContext): string =>
  JSON.stringify({
    sessionId: ic.sessionId,
    nodes: ic.nodes,
    users: Object.fromEntries(ic.users),
  }, null, 2);

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

const reduceAndLog = (
  sessions: Map<string, IntermediateContext>,
  renderedSessions: Map<string, RenderedContext>,
  chatId: string,
  event: Parameters<typeof reduce>[1],
  renderParams: RenderParams,
) => {
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
};

const main = async () => {
  const config = loadConfig();

  const db = createDatabase(config.database.path, logger);
  runMigrations(db, logger);

  // Bot user ID from token — available immediately, used for myself detection
  const botUserId = config.telegram.botToken.split(':')[0]!;
  const renderParams: RenderParams = { botUserId };

  // Cold-start: replay events per chat to rebuild IC + RC
  const sessions = new Map<string, IntermediateContext>();
  const renderedSessions = new Map<string, RenderedContext>();
  for (const chatId of loadKnownChatIds(db)) {
    let ic = createEmptyIC(chatId);
    const events = loadEvents(db, chatId);
    for (const event of events)
      ic = reduce(ic, event);
    sessions.set(chatId, ic);
    dumpIC(ic);

    const rc = render(ic, renderParams);
    renderedSessions.set(chatId, rc);
    logRendering(chatId, undefined, rc);
    dumpRC(chatId, rc);

    logger.withFields({ chatId, events: events.length, nodes: ic.nodes.length, users: ic.users.size }).log('Replayed session');
  }
  logger.withFields({ sessions: sessions.size }).log('Cold start complete');

  const telegram = createTelegramManager({
    botToken: config.telegram.botToken,
    apiId: config.telegram.apiId,
    apiHash: config.telegram.apiHash,
    session: loadSession(config.telegram.session),
    initialChatIds: loadKnownChatIds(db),
    resolveChatId: messageIds => lookupChatId(db, messageIds),
  }, logger);

  const driver = createDriver({
    apiBaseUrl: config.llm.apiBaseUrl,
    apiKey: config.llm.apiKey,
    model: config.llm.model,
    maxContextTokens: config.llm.maxContextTokens,
    chatIds: config.driver.chatIds,
    reasoningSignatureCompat: config.llm.reasoningSignatureCompat,
    featureFlags: config.features,
  }, {
    db,
    sendMessage: async (chatId, text, replyToMessageId) => {
      const sent = await telegram.sendMessage(chatId, text, replyToMessageId ? { replyToMessageId } : undefined);

      // Bypass: inject bot's own sent message as a synthetic event so it
      // enters the pipeline immediately, without relying on userbot reception.
      const botInfo = telegram.bot.botInfo();
      const now = Date.now();
      const event: CanonicalMessageEvent = {
        type: 'message',
        chatId,
        messageId: String(sent.messageId),
        sender: {
          id: botUserId,
          displayName: botInfo?.firstName ?? 'Bot',
          username: botInfo?.username,
          isBot: true,
        },
        receivedAtMs: now,
        timestampSec: sent.date,
        utcOffsetMin: captureUtcOffset(),
        content: parseContent(sent.text, sent.entities),
        attachments: [],
        isSelfSent: true,
      };
      if (replyToMessageId != null) event.replyToMessageId = String(replyToMessageId);

      // Detect userbot winning the race — message already in IC before synthetic bypass
      const ic = sessions.get(chatId);
      if (ic?.nodes.some(n => n.type === 'message' && n.messageId === event.messageId))
        logger.withFields({ chatId, messageId: event.messageId }).warn('Synthetic bypass: userbot arrived first (isSelfSent merged via dedup)');

      persistEvent(db, event);
      reduceAndLog(sessions, renderedSessions, chatId, event, renderParams);
      // Don't call driver.handleEvent — we're inside the Driver's LLM call;
      // the self-loop check will prevent re-triggering on bot-only messages.

      return sent;
    },
    logger,
  });

  logger.withFields({ chatIds: config.driver.chatIds }).log('Driver initialized');

  // Feed replayed sessions into Driver so it can respond to un-answered messages
  for (const [chatId, rc] of renderedSessions)
    driver.handleEvent(chatId, rc);

  telegram.onMessage(msg => {
    logger.withFields({
      source: msg.source,
      chatId: msg.chatId,
      messageId: msg.messageId,
      sender: msg.sender?.username ?? msg.sender?.firstName ?? msg.sender?.id ?? 'unknown',
      text: msg.text.length > 100 ? `${msg.text.slice(0, 100)}...` : msg.text,
      length: msg.text.length,
    }).log('Message received');

    const event = adaptMessage(msg);
    persistEvent(db, event);

    try {
      persistMessage(db, msg);
    } catch (err) {
      logger.withError(err).error('Failed to persist message');
    }

    reduceAndLog(sessions, renderedSessions, event.chatId, event, renderParams);
    driver.handleEvent(event.chatId, renderedSessions.get(event.chatId)!);
  });

  telegram.onMessageEdit(edit => {
    logger.withFields({
      chatId: edit.chatId,
      messageId: edit.messageId,
      sender: edit.sender?.username ?? edit.sender?.firstName ?? edit.sender?.id ?? 'unknown',
      text: edit.text.length > 100 ? `${edit.text.slice(0, 100)}...` : edit.text,
      length: edit.text.length,
    }).log('Message edited');

    const event = adaptEdit(edit);

    // Phantom edit detection: Telegram fires updateEditMessage with editDate set
    // for metadata-only changes (link preview resolved, reactions, client re-saves).
    // Skip if text, content, and attachments are identical to the stored event.
    const prev = loadLatestMessageContent(db, event.chatId, event.messageId);
    if (prev) {
      const newText = contentToPlainText(event.content) || null;
      const newContent = event.content.length > 0 ? event.content : null;
      const newAttachments = event.attachments.length > 0 ? event.attachments : null;
      if (prev.text === newText
        && JSON.stringify(prev.content) === JSON.stringify(newContent)
        && JSON.stringify(prev.attachments) === JSON.stringify(newAttachments)) {
        logger.withFields({ chatId: edit.chatId, messageId: edit.messageId }).log('Phantom edit skipped (content unchanged)');
        return;
      }
    }

    persistEvent(db, event);

    try {
      persistMessageEdit(db, edit);
    } catch (err) {
      logger.withError(err).error('Failed to persist message edit');
    }

    reduceAndLog(sessions, renderedSessions, event.chatId, event, renderParams);
    driver.handleEvent(event.chatId, renderedSessions.get(event.chatId)!);
  });

  telegram.onMessageDelete(del => {
    logger.withFields({
      chatId: del.chatId ?? 'unknown',
      messageIds: del.messageIds,
    }).log('Message deleted');

    const event = adaptDelete(del);
    persistEvent(db, event);

    try {
      persistMessageDelete(db, del);
    } catch (err) {
      logger.withError(err).error('Failed to persist message delete');
    }

    reduceAndLog(sessions, renderedSessions, event.chatId, event, renderParams);
    driver.handleEvent(event.chatId, renderedSessions.get(event.chatId)!);
  });

  const shutdown = async () => {
    logger.log('Shutting down...');
    driver.stop();
    await telegram.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await telegram.start();
  logger.log('Cahciua is running');
};

main().catch(err => {
  logger.withError(err).error('Fatal error');
  process.exit(1);
});
