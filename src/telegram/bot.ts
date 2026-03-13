import type { Logger } from '@guiiai/logg';
import type { Context } from 'grammy';
import { Bot } from 'grammy';

import { httpGetBuffer, registerHttpSecret } from '../http';
import { createEventBus } from './event-bus';
import type { TelegramMessage } from './message';
import { fromGrammyMessage } from './message';

export interface BotClientOptions {
  token: string;
}

export interface BotInfo {
  id: number;
  firstName: string;
  username?: string;
}

export interface SentMessage {
  messageId: number;
  date: number;
}

export interface BotClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage: (handler: (msg: TelegramMessage) => void) => void;
  sendMessage(chatId: string | number, text: string, options?: SendOptions): Promise<SentMessage>;
  downloadFile(fileId: string): Promise<Buffer>;
  raw(): Bot;
  botUserId(): string;
  botInfo(): BotInfo | undefined;
}

export interface SendOptions {
  replyToMessageId?: number;
  parseMode?: 'HTML' | 'MarkdownV2';
}

export const createBotClient = (options: BotClientOptions, logger: Logger): BotClient => {
  const log = logger.withContext('telegram:bot');
  const bot = new Bot(options.token);

  registerHttpSecret(options.token);

  const messageBus = createEventBus<TelegramMessage>('bot:message', log);

  const downloadFile = async (fileId: string): Promise<Buffer> => {
    const file = await bot.api.getFile(fileId);
    return await httpGetBuffer(`https://api.telegram.org/file/bot${options.token}/${file.file_path}`);
  };

  bot.command('start', async ctx => {
    await ctx.reply('Cahciua is running.');
  });

  bot.on('message', (ctx: Context) => {
    if (!ctx.message) return;
    messageBus.emit(fromGrammyMessage(ctx.message));
  });

  bot.catch(err => {
    log.withError(err.error).error('Bot error');
  });

  // Bot user ID extracted from token (available immediately, no getMe needed)
  const userId = options.token.split(':')[0]!;
  let info: BotInfo | undefined;

  const start = async () => {
    log.log('Starting bot...');
    const me = await bot.api.getMe();
    info = { id: me.id, firstName: me.first_name, username: me.username };
    log.withFields({
      id: me.id,
      username: me.username,
      name: [me.first_name, me.last_name].filter(Boolean).join(' '),
    }).log('Bot authenticated');

    void bot.start({
      onStart: () => {
        log.log('Bot polling started');
      },
    });
  };

  const stop = async () => {
    log.log('Stopping bot...');
    await bot.stop();
    log.log('Bot stopped');
  };

  const sendMessage = async (chatId: string | number, text: string, options?: SendOptions): Promise<SentMessage> => {
    const sent = await bot.api.sendMessage(chatId, text, {
      reply_parameters: options?.replyToMessageId
        ? { message_id: options.replyToMessageId }
        : undefined,
      parse_mode: options?.parseMode,
    });
    return { messageId: sent.message_id, date: sent.date };
  };

  return {
    start,
    stop,
    onMessage: messageBus.on,
    sendMessage,
    downloadFile,
    raw: () => bot,
    botUserId: () => userId,
    botInfo: () => info,
  };
};
