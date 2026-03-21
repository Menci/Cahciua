import { adaptDelete, adaptEdit, adaptMessage, adaptServiceEvent, contentToPlainText, isServiceMessage } from './adaptation';
import type { CanonicalIMEvent } from './adaptation/types';
import { getChatIds, loadConfig, resolveChatConfig, resolveModel } from './config/config';
import { setupLogger, useLogger } from './config/logger';
import { createDatabase, loadCompaction, loadEvents, loadImageAltTextByHash, loadKnownChatIds, loadLastProbeTime, loadLatestMessageContent, loadTurnResponses, lookupChatId, persistCompaction, persistEvent, persistImageAltText, persistMessage, persistMessageDelete, persistMessageEdit, persistProbeResponse, persistTurnResponse, runMigrations } from './db';
import { createDriver } from './driver';
import { createPipeline } from './pipeline';
import type { RenderParams } from './rendering';
import { createTelegramManager } from './telegram';
import { computeThumbnailHash, createImageToTextResolver } from './telegram/image-to-text';
import { loadSession } from './telegram/session';

setupLogger();

const logger = useLogger('cahciua');

const main = async () => {
  const config = loadConfig();

  const chatIds = getChatIds(config);

  // Compute per-chat image-to-text enablement
  const imageToTextChatIds = new Set(
    chatIds.filter(id => resolveChatConfig(config, id).imageToText.enabled),
  );

  // Use default chat config's imageToText model for the shared resolver
  const defaultChatConfig = resolveChatConfig(config, 'default');
  if (imageToTextChatIds.size > 0 && !defaultChatConfig.imageToText.model)
    throw new Error('imageToText.model is required when imageToText.enabled=true (in chats.default or per-chat override)');

  const db = createDatabase(config.database.path, logger);
  runMigrations(db, logger);

  // Image-to-text resolver — shared between cold-start replay and live ingress.
  const imageToTextResolver = createImageToTextResolver({
    enabled: imageToTextChatIds.size > 0,
    model: defaultChatConfig.imageToText.model ? resolveModel(config, defaultChatConfig.imageToText.model) : undefined,
    logger,
    lookupByHash: imageHash => loadImageAltTextByHash(db, imageHash),
    persist: record => persistImageAltText(db, record),
  });

  // Sync hydration: after persistEvent, set altText transiently on canonical
  // attachments from the image_alt_texts table so rendering can use it.
  // This is a sync DB lookup (better-sqlite3) — never stored back into events.
  const hydrateAltTextFromCache = (event: CanonicalIMEvent) => {
    if (imageToTextChatIds.size === 0) return;
    if (event.type !== 'message' && event.type !== 'edit') return;
    for (const att of event.attachments) {
      if (att.altText || !att.thumbnailWebp) continue;
      const cached = loadImageAltTextByHash(db, computeThumbnailHash(att.thumbnailWebp));
      if (cached) att.altText = cached.altText;
    }
  };

  // Bot user ID from token — available immediately, used for myself detection
  const botUserId = config.telegram.botToken.split(':')[0]!;
  const renderParams: RenderParams = { botUserId };

  const pipeline = createPipeline(renderParams);

  // Cold-start: replay events per chat to rebuild IC + RC.
  // If a compaction cursor exists, only load events from that point onward —
  // older events are summarised and no longer needed for IC or rendering.
  for (const chatId of loadKnownChatIds(db)) {
    const compaction = loadCompaction(db, chatId);
    if (compaction)
      pipeline.setCompactCursor(chatId, compaction.newCursorMs);
    const events = loadEvents(db, chatId, compaction?.newCursorMs);
    if (imageToTextChatIds.has(chatId)) {
      const tasks: Promise<void>[] = [];
      for (const event of events) {
        if ((event.type === 'message' || event.type === 'edit') && event.attachments.length > 0) {
          const caption = contentToPlainText(event.content);
          tasks.push(imageToTextResolver.hydrateCanonicalAttachments(event.attachments, caption));
        }
      }
      if (tasks.length > 0) await Promise.all(tasks);
      // After async hydration resolves, all cache entries exist.
      // Sync-hydrate every event so altText is set transiently for rendering.
      for (const event of events) hydrateAltTextFromCache(event);
    }
    pipeline.replayChat(chatId, events);
  }
  logger.withFields({ sessions: pipeline.getChatIds().length }).log('Cold start complete');

  const telegram = createTelegramManager({
    botToken: config.telegram.botToken,
    apiId: config.telegram.apiId,
    apiHash: config.telegram.apiHash,
    session: loadSession(config.telegram.session),
    initialChatIds: loadKnownChatIds(db),
    resolveChatId: messageIds => lookupChatId(db, messageIds),
    imageToText: imageToTextChatIds.size > 0 ? imageToTextResolver : undefined,
    imageToTextChatIds,
  }, logger);

  const driver = createDriver({
    chatIds,
    resolveChatConfig: id => resolveChatConfig(config, id),
  }, {
    loadTurnResponses: (chatId, afterMs) => loadTurnResponses(db, chatId, afterMs),
    persistTurnResponse: (chatId, tr) => persistTurnResponse(db, chatId, tr),
    persistProbeResponse: (chatId, probe) => persistProbeResponse(db, chatId, probe),
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
      hydrateAltTextFromCache(event);
      pipeline.pushEvent(chatId, event);
      // Don't call driver.handleEvent — we're inside the Driver's LLM call;
      // the self-loop check will prevent re-triggering on bot-only messages.

      return sent;
    },
    loadCompaction: chatId => loadCompaction(db, chatId),
    loadLastProbeTime: chatId => loadLastProbeTime(db, chatId),
    persistCompaction: (chatId, meta) => persistCompaction(db, chatId, meta),
    setCompactCursor: (chatId, cursorMs) => pipeline.setCompactCursor(chatId, cursorMs),
    logger,
  });

  logger.withFields({ chatIds }).log('Driver initialized');

  // Feed replayed sessions into Driver so it can respond to un-answered messages
  // and trigger compaction check if context exceeds budget (compaction effect fires
  // automatically when conditions are met — no explicit startup trigger needed).
  for (const chatId of pipeline.getChatIds()) {
    const rc = pipeline.getRC(chatId);
    if (rc) driver.handleEvent(chatId, rc);
  }

  telegram.onMessage(msg => {
    // Service messages (join/leave/rename/pin/etc.) — route to service event path
    if (isServiceMessage(msg)) {
      const event = adaptServiceEvent(msg);
      if (event) {
        logger.withFields({
          source: msg.source,
          chatId: msg.chatId,
          action: event.action.action,
        }).log('Service event received');

        persistEvent(db, event);
        const rc = pipeline.pushEvent(event.chatId, event);
        driver.handleEvent(event.chatId, rc);
      }
      return;
    }

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
    hydrateAltTextFromCache(event);

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
    hydrateAltTextFromCache(event);

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
