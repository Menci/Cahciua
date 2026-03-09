import type { Logger } from '@guiiai/logg';
import type { Context } from 'grammy';
import { Bot } from 'grammy';

import type { TelegramMessage } from './message';
import { fromGrammyMessage } from './message';

export interface BotClientOptions {
  token: string;
}

export interface BotClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: TelegramMessage) => void): void;
  sendMessage(chatId: string | number, text: string, options?: SendOptions): Promise<void>;
  raw(): Bot;
}

export interface SendOptions {
  replyToMessageId?: number;
  parseMode?: 'HTML' | 'MarkdownV2';
}

export function createBotClient(options: BotClientOptions, logger: Logger): BotClient {
  const log = logger.withContext('telegram:bot');
  const bot = new Bot(options.token);

  const messageHandlers: Array<(msg: TelegramMessage) => void> = [];

  bot.command('start', async ctx => {
    await ctx.reply('Cahciua is running.');
  });

  bot.on('message', (ctx: Context) => {
    if (!ctx.message) return;

    const msg = fromGrammyMessage(ctx.message);
    for (const handler of messageHandlers) {
      try {
        handler(msg);
      } catch (err) {
        log.withError(err).error('Message handler error');
      }
    }
  });

  bot.catch(err => {
    log.withError(err.error).error('Bot error');
  });

  async function start() {
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
  }

  async function stop() {
    log.log('Stopping bot...');
    await bot.stop();
    log.log('Bot stopped');
  }

  async function sendMessage(chatId: string | number, text: string, options?: SendOptions) {
    await bot.api.sendMessage(chatId, text, {
      reply_parameters: options?.replyToMessageId
        ? { message_id: options.replyToMessageId }
        : undefined,
      parse_mode: options?.parseMode,
    });
  }

  return {
    start,
    stop,
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    sendMessage,
    raw: () => bot,
  };
}
