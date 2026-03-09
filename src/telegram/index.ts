import type { Logger } from '@guiiai/logg';

import type { BotClient, SendOptions } from './bot';
import { createBotClient } from './bot';
import { createEventBus } from './event-bus';
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
  onMessage: (handler: (msg: TelegramMessage) => void) => void;
  onMessageEdit: (handler: (edit: TelegramMessageEdit) => void) => void;
  onMessageDelete: (handler: (del: TelegramMessageDelete) => void) => void;
  sendMessage(chatId: string | number, text: string, options?: SendOptions): Promise<void>;
  fetchMessages(chatId: string, options: FetchOptions): Promise<TelegramMessage[]>;
  fetchSpecificMessages(chatId: string, messageIds: number[]): Promise<TelegramMessage[]>;
  bot: BotClient;
  userbot: UserbotClient;
}

export const createTelegramManager = (
  options: TelegramManagerOptions,
  logger: Logger,
): TelegramManager => {
  const bot = createBotClient({ token: options.botToken }, logger);
  const userbot = createUserbotClient({
    apiId: options.apiId,
    apiHash: options.apiHash,
    session: options.session,
  }, logger);

  const dedup = createMessageDedup();
  const botChats = new Set<string>();
  const messageBus = createEventBus<TelegramMessage>('telegram:message', logger);
  const editBus = createEventBus<TelegramMessageEdit>('telegram:edit', logger);
  const deleteBus = createEventBus<TelegramMessageDelete>('telegram:delete', logger);

  const dispatchMessage = (msg: TelegramMessage) => {
    if (!dedup.tryAdd(msg.chatId, msg.messageId)) return;
    messageBus.emit(msg);
  };

  bot.onMessage(msg => {
    botChats.add(msg.chatId);
    dispatchMessage(msg);
  });

  userbot.onMessage(msg => {
    if (!botChats.has(msg.chatId)) return;
    dispatchMessage(msg);
  });

  userbot.onMessageEdit(edit => {
    if (!botChats.has(edit.chatId)) return;
    editBus.emit(edit);
  });

  userbot.onMessageDelete(del => {
    if (del.chatId && !botChats.has(del.chatId)) return;
    deleteBus.emit(del);
  });

  const start = async () => {
    await Promise.all([
      bot.start(),
      userbot.start(),
    ]);
  };

  const stop = async () => {
    await Promise.all([
      bot.stop(),
      userbot.stop(),
    ]);
  };

  return {
    start,
    stop,
    onMessage: messageBus.on,
    onMessageEdit: editBus.on,
    onMessageDelete: deleteBus.on,
    sendMessage: (chatId, text, opts) => bot.sendMessage(chatId, text, opts),
    fetchMessages: (chatId, opts) => userbot.fetchMessages(chatId, opts),
    fetchSpecificMessages: (chatId, ids) => userbot.fetchSpecificMessages(chatId, ids),
    bot,
    userbot,
  };
};
