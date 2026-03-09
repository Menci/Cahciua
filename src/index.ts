import dotenv from 'dotenv';

import { adaptDelete, adaptEdit, adaptMessage } from './adaptation';
import { loadEnv } from './config/env';
import { setupLogger, useLogger } from './config/logger';
import { createDatabase, loadRecentEvents, lookupChatId, persistEvent, persistMessage, persistMessageDelete, persistMessageEdit, runMigrations } from './db';
import { createTelegramManager } from './telegram';
import { loadSession } from './telegram/session';

dotenv.config();
setupLogger();

const logger = useLogger('cahciua');

const main = async () => {
  const env = loadEnv();

  const db = createDatabase(env.DB_PATH, logger);
  runMigrations(db, logger);

  const recentEvents = loadRecentEvents(db, 100);
  logger.withFields({ count: recentEvents.length }).log('Replayed recent events from DB');
  for (const event of recentEvents) {
    if (event.type === 'message') {
      const sender = event.sender?.displayName ?? event.sender?.id ?? 'unknown';
      const text = event.text.length > 80 ? `${event.text.slice(0, 80)}...` : event.text;
      logger.withFields({ chatId: event.chatId, messageId: event.messageId, sender, text }).log('[replay] message');
    } else if (event.type === 'edit') {
      const sender = event.sender?.displayName ?? event.sender?.id ?? 'unknown';
      const text = event.text.length > 80 ? `${event.text.slice(0, 80)}...` : event.text;
      logger.withFields({ chatId: event.chatId, messageId: event.messageId, sender, text }).log('[replay] edit');
    } else {
      logger.withFields({ chatId: event.chatId, messageIds: event.messageIds }).log('[replay] delete');
    }
  }

  const telegram = createTelegramManager({
    botToken: env.TELEGRAM_BOT_TOKEN,
    apiId: env.TELEGRAM_API_ID,
    apiHash: env.TELEGRAM_API_HASH,
    session: loadSession(env.TELEGRAM_SESSION),
    resolveChatId: messageIds => lookupChatId(db, messageIds),
  }, logger);

  telegram.onMessage(msg => {
    logger.withFields({
      source: msg.source,
      chatId: msg.chatId,
      messageId: msg.messageId,
      sender: msg.sender?.username ?? msg.sender?.firstName ?? msg.sender?.id ?? 'unknown',
      text: msg.text.length > 100 ? `${msg.text.slice(0, 100)}...` : msg.text,
    }).log('Message received');

    const event = adaptMessage(msg);

    try {
      persistEvent(db, event);
    } catch (err) {
      logger.withError(err).error('Failed to persist event');
    }

    try {
      persistMessage(db, msg);
    } catch (err) {
      logger.withError(err).error('Failed to persist message');
    }
  });

  telegram.onMessageEdit(edit => {
    logger.withFields({
      chatId: edit.chatId,
      messageId: edit.messageId,
      sender: edit.sender?.username ?? edit.sender?.firstName ?? edit.sender?.id ?? 'unknown',
      text: edit.text.length > 100 ? `${edit.text.slice(0, 100)}...` : edit.text,
    }).log('Message edited');

    const event = adaptEdit(edit);

    try {
      persistEvent(db, event);
    } catch (err) {
      logger.withError(err).error('Failed to persist event');
    }

    try {
      persistMessageEdit(db, edit);
    } catch (err) {
      logger.withError(err).error('Failed to persist message edit');
    }
  });

  telegram.onMessageDelete(del => {
    logger.withFields({
      chatId: del.chatId ?? 'unknown',
      messageIds: del.messageIds,
    }).log('Message deleted');

    const event = adaptDelete(del);

    try {
      persistEvent(db, event);
    } catch (err) {
      logger.withError(err).error('Failed to persist event');
    }

    try {
      persistMessageDelete(db, del);
    } catch (err) {
      logger.withError(err).error('Failed to persist message delete');
    }
  });

  const shutdown = async () => {
    logger.log('Shutting down...');
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
