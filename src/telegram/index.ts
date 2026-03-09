import type { Logger } from '@guiiai/logg';

import type { BotClient, SendOptions } from './bot';
import { createBotClient } from './bot';
import type { TelegramMessage, TelegramMessageDelete, TelegramMessageEdit } from './message';
import { createMessageDedup } from './message';
import type { FetchOptions, UserbotClient } from './userbot';
import { createUserbotClient } from './userbot';

export interface TelegramManagerOptions {
  botToken: string;
  apiId: number;
  apiHash: string;
  session: string;
}

export interface TelegramManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: TelegramMessage) => void): void;
  onMessageEdit(handler: (edit: TelegramMessageEdit) => void): void;
  onMessageDelete(handler: (del: TelegramMessageDelete) => void): void;
  sendMessage(chatId: string | number, text: string, options?: SendOptions): Promise<void>;
  fetchMessages(chatId: string, options: FetchOptions): Promise<TelegramMessage[]>;
  fetchSpecificMessages(chatId: string, messageIds: number[]): Promise<TelegramMessage[]>;
  bot: BotClient;
  userbot: UserbotClient;
}

export function createTelegramManager(
  options: TelegramManagerOptions,
  logger: Logger,
): TelegramManager {
  const log = logger.withContext('telegram');

  const bot = createBotClient({ token: options.botToken }, logger);
  const userbot = createUserbotClient({
    apiId: options.apiId,
    apiHash: options.apiHash,
    session: options.session,
  }, logger);

  const dedup = createMessageDedup();
  const messageHandlers: Array<(msg: TelegramMessage) => void> = [];
  const editHandlers: Array<(edit: TelegramMessageEdit) => void> = [];
  const deleteHandlers: Array<(del: TelegramMessageDelete) => void> = [];

  function dispatchMessage(msg: TelegramMessage) {
    if (!dedup.tryAdd(msg.chatId, msg.messageId)) {
      return;
    }
    for (const handler of messageHandlers) {
      try {
        handler(msg);
      } catch (err) {
        log.withError(err).error('Message dispatch error');
      }
    }
  }

  userbot.onMessage(dispatchMessage);
  bot.onMessage(dispatchMessage);

  userbot.onMessageEdit(edit => {
    for (const handler of editHandlers) {
      try {
        handler(edit);
      } catch (err) {
        log.withError(err).error('Edit dispatch error');
      }
    }
  });

  userbot.onMessageDelete(del => {
    for (const handler of deleteHandlers) {
      try {
        handler(del);
      } catch (err) {
        log.withError(err).error('Delete dispatch error');
      }
    }
  });

  async function start() {
    log.log('Starting Telegram manager...');
    await Promise.all([
      bot.start(),
      userbot.start(),
    ]);
    log.log('Telegram manager started');
  }

  async function stop() {
    log.log('Stopping Telegram manager...');
    await Promise.all([
      bot.stop(),
      userbot.stop(),
    ]);
    log.log('Telegram manager stopped');
  }

  return {
    start,
    stop,
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onMessageEdit(handler) {
      editHandlers.push(handler);
    },
    onMessageDelete(handler) {
      deleteHandlers.push(handler);
    },
    sendMessage: (chatId, text, opts) => bot.sendMessage(chatId, text, opts),
    fetchMessages: (chatId, opts) => userbot.fetchMessages(chatId, opts),
    fetchSpecificMessages: (chatId, ids) => userbot.fetchSpecificMessages(chatId, ids),
    bot,
    userbot,
  };
}
