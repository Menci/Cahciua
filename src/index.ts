import dotenv from 'dotenv';

import { loadEnv } from './config/env';
import { setupLogger, useLogger } from './config/logger';
import { createDatabase, persistMessage, persistMessageDelete, persistMessageEdit, runMigrations } from './db';
import { createTelegramManager } from './telegram';
import { loadSession } from './telegram/session';

dotenv.config();
setupLogger();

const logger = useLogger('cahciua');

async function main() {
  const env = loadEnv();

  const db = createDatabase(env.DB_PATH, logger);
  runMigrations(db, logger);

  const telegram = createTelegramManager({
    botToken: env.TELEGRAM_BOT_TOKEN,
    apiId: env.TELEGRAM_API_ID,
    apiHash: env.TELEGRAM_API_HASH,
    session: loadSession(env.TELEGRAM_SESSION),
  }, logger);

  telegram.onMessage(msg => {
    logger.withFields({
      source: msg.source,
      chatId: msg.chatId,
      messageId: msg.messageId,
      sender: msg.sender?.username ?? msg.sender?.firstName ?? msg.sender?.id ?? 'unknown',
      text: msg.text.length > 100 ? `${msg.text.slice(0, 100)}...` : msg.text,
    }).log('Message received');
    persistMessage(db, msg);
  });

  telegram.onMessageEdit(edit => {
    logger.withFields({
      chatId: edit.chatId,
      messageId: edit.messageId,
      sender: edit.sender?.username ?? edit.sender?.firstName ?? edit.sender?.id ?? 'unknown',
      text: edit.text.length > 100 ? `${edit.text.slice(0, 100)}...` : edit.text,
    }).log('Message edited');
    persistMessageEdit(db, edit);
  });

  telegram.onMessageDelete(del => {
    logger.withFields({
      chatId: del.chatId ?? 'unknown',
      messageIds: del.messageIds,
    }).log('Message deleted');
    persistMessageDelete(db, del);
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
}

main().catch(err => {
  logger.withError(err).error('Fatal error');
  process.exit(1);
});
