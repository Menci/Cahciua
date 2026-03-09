import type { Logger } from '@guiiai/logg';
import type { Context } from 'grammy';
import { Bot } from 'grammy';

import { createEventBus } from './event-bus';
import type { TelegramMessage } from './message';
import { fromGrammyMessage } from './message';
import { hydrateAttachmentThumbnails } from './thumbnail';

export interface BotClientOptions {
  token: string;
}

export interface BotClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage: (handler: (msg: TelegramMessage) => void) => void;
  sendMessage(chatId: string | number, text: string, options?: SendOptions): Promise<void>;
  downloadFile(fileId: string): Promise<Buffer>;
  raw(): Bot;
}

export interface SendOptions {
  replyToMessageId?: number;
  parseMode?: 'HTML' | 'MarkdownV2';
}

export const createBotClient = (options: BotClientOptions, logger: Logger): BotClient => {
  const log = logger.withContext('telegram:bot');
  const bot = new Bot(options.token);

  const messageBus = createEventBus<TelegramMessage>('bot:message', log);

  const downloadFile = async (fileId: string): Promise<Buffer> => {
    const file = await bot.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${options.token}/${file.file_path}`;
    const resp = await fetch(url);
    return Buffer.from(await resp.arrayBuffer());
  };

  bot.command('start', async ctx => {
    await ctx.reply('Cahciua is running.');
  });

  bot.on('message', async (ctx: Context) => {
    if (!ctx.message) return;
    const msg = fromGrammyMessage(ctx.message);
    await hydrateAttachmentThumbnails(msg.attachments, downloadFile, log);
    messageBus.emit(msg);
  });

  bot.catch(err => {
    log.withError(err.error).error('Bot error');
  });

  const start = async () => {
    log.log('Starting bot...');
    const me = await bot.api.getMe();
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

  const sendMessage = async (chatId: string | number, text: string, options?: SendOptions) => {
    await bot.api.sendMessage(chatId, text, {
      reply_parameters: options?.replyToMessageId
        ? { message_id: options.replyToMessageId }
        : undefined,
      parse_mode: options?.parseMode,
    });
  };

  return {
    start,
    stop,
    onMessage: messageBus.on,
    sendMessage,
    downloadFile,
    raw: () => bot,
  };
};
