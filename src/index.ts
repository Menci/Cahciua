import { adaptDelete, adaptEdit, adaptMessage, contentToPlainText } from './adaptation';
import { loadConfig } from './config/config';
import { setupLogger, useLogger } from './config/logger';
import { createDatabase, loadCompaction, loadEvents, loadKnownChatIds, loadLatestMessageContent, loadTurnResponses, lookupChatId, persistCompaction, persistEvent, persistMessage, persistMessageDelete, persistMessageEdit, persistTurnResponse, runMigrations } from './db';
import { createDriver } from './driver';
import { createPipeline } from './pipeline';
import type { RenderParams } from './rendering';
import { createTelegramManager } from './telegram';
import { loadSession } from './telegram/session';

setupLogger();

const logger = useLogger('cahciua');

const main = async () => {
  const config = loadConfig();

  const db = createDatabase(config.database.path, logger);
  runMigrations(db, logger);

  // Bot user ID from token — available immediately, used for myself detection
  const botUserId = config.telegram.botToken.split(':')[0]!;
  const renderParams: RenderParams = { botUserId };

  const pipeline = createPipeline(renderParams);

  // Cold-start: replay events per chat to rebuild IC + RC.
  // If a compaction cursor exists, set it before replay so rendering
  // skips nodes before the cursor. IC still replays all events (user map, etc.).
  for (const chatId of loadKnownChatIds(db)) {
    const compaction = loadCompaction(db, chatId);
    if (compaction)
      pipeline.setCompactCursor(chatId, compaction.newCursorMs);
    pipeline.replayChat(chatId, loadEvents(db, chatId));
  }
  logger.withFields({ sessions: pipeline.getChatIds().length }).log('Cold start complete');

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
    compaction: config.compaction,
  }, {
    loadTurnResponses: (chatId, afterMs) => {
      const rows = loadTurnResponses(db, chatId, afterMs);
      return rows.map(r => ({
        requestedAtMs: r.requestedAt,
        provider: r.provider,
        data: r.data,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        reasoningSignatureCompat: r.reasoningSignatureCompat ?? '',
      }));
    },
    persistTurnResponse: (chatId, tr) => persistTurnResponse(db, chatId, {
      ...tr,
      requestedAtMs: tr.requestedAtMs,
    }),
    sendMessage: async (chatId, text, replyToMessageId) => {
      const sent = await telegram.sendMessage(chatId, text, replyToMessageId ? { replyToMessageId } : undefined);

      // Bypass: inject bot's own sent message as a synthetic event so it
      // enters the pipeline immediately, without relying on userbot reception.
      const botInfo = telegram.bot.botInfo();
      const syntheticMsg = {
        messageId: sent.messageId,
        chatId,
        sender: {
          id: botUserId,
          firstName: botInfo?.firstName ?? 'Bot',
          username: botInfo?.username,
          isBot: true,
          isPremium: false,
        },
        date: sent.date,
        text: sent.text,
        entities: sent.entities,
        replyToMessageId,
        source: 'bot' as const,
      };
      const event = adaptMessage(syntheticMsg);
      event.isSelfSent = true;

      // Detect userbot winning the race — message already in IC before synthetic bypass
      const ic = pipeline.getIC(chatId);
      if (ic?.nodes.some(n => n.type === 'message' && n.messageId === event.messageId))
        logger.withFields({ chatId, messageId: event.messageId }).warn('Synthetic bypass: userbot arrived first (isSelfSent merged via dedup)');

      persistEvent(db, event);
      pipeline.pushEvent(chatId, event);
      // Don't call driver.handleEvent — we're inside the Driver's LLM call;
      // the self-loop check will prevent re-triggering on bot-only messages.

      return sent;
    },
    loadCompaction: chatId => loadCompaction(db, chatId),
    persistCompaction: (chatId, meta) => persistCompaction(db, chatId, meta),
    setCompactCursor: (chatId, cursorMs) => pipeline.setCompactCursor(chatId, cursorMs),
    logger,
  });

  logger.withFields({ chatIds: config.driver.chatIds }).log('Driver initialized');

  // Feed replayed sessions into Driver so it can respond to un-answered messages
  // and trigger compaction check if context exceeds budget (compaction effect fires
  // automatically when conditions are met — no explicit startup trigger needed).
  for (const chatId of pipeline.getChatIds()) {
    const rc = pipeline.getRC(chatId);
    if (rc) driver.handleEvent(chatId, rc);
  }

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

    try { persistMessage(db, msg); } catch (err) { logger.withError(err).error('Failed to persist message'); }

    const rc = pipeline.pushEvent(event.chatId, event);
    driver.handleEvent(event.chatId, rc);
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

    try { persistMessageEdit(db, edit); } catch (err) { logger.withError(err).error('Failed to persist message edit'); }

    const rc = pipeline.pushEvent(event.chatId, event);
    driver.handleEvent(event.chatId, rc);
  });

  telegram.onMessageDelete(del => {
    logger.withFields({
      chatId: del.chatId ?? 'unknown',
      messageIds: del.messageIds,
    }).log('Message deleted');

    const event = adaptDelete(del);
    persistEvent(db, event);

    try { persistMessageDelete(db, del); } catch (err) { logger.withError(err).error('Failed to persist message delete'); }

    const rc = pipeline.pushEvent(event.chatId, event);
    driver.handleEvent(event.chatId, rc);
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
