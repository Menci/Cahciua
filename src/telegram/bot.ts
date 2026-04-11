import type { Logger } from '@guiiai/logg';
import type { Context } from 'grammy';
import { Bot, InputFile } from 'grammy';
import type { InputMediaAudio, InputMediaDocument, InputMediaPhoto, InputMediaVideo } from 'grammy/types';

import { httpGetBuffer, registerHttpSecret } from '../http';
import { createEventBus } from './event-bus';
import { renderMarkdownToTelegramHTML } from './markdown';
import type { TelegramMessage } from './message';
import { convertGrammyEntities, fromGrammyMessage } from './message';
import type { MessageEntity } from './message/types';

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
  text: string;
  entities?: MessageEntity[];
}

export interface SendOptions {
  replyToMessageId?: number;
  parseMode?: 'HTML' | 'MarkdownV2';
}

export interface MediaSendOptions extends SendOptions {
  fileName?: string;
  caption?: string;
  captionParseMode?: 'HTML' | 'MarkdownV2';
}

export interface MediaGroupItem {
  type: 'photo' | 'video' | 'audio' | 'document';
  buffer: Buffer;
  fileName?: string;
  caption?: string;
  captionParseMode?: 'HTML' | 'MarkdownV2';
}

export interface BotClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage: (handler: (msg: TelegramMessage) => void) => void;
  sendMessage(chatId: string | number, text: string, options?: SendOptions): Promise<SentMessage>;
  sendPhoto(chatId: string | number, photo: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendDocument(chatId: string | number, document: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendVideo(chatId: string | number, video: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendAudio(chatId: string | number, audio: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendVoice(chatId: string | number, voice: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendAnimation(chatId: string | number, animation: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendVideoNote(chatId: string | number, videoNote: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendMediaGroup(chatId: string | number, media: MediaGroupItem[], options?: SendOptions): Promise<SentMessage[]>;
  downloadFile(fileId: string): Promise<Buffer>;
  raw(): Bot;
  botUserId(): string;
  botInfo(): BotInfo | undefined;
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

  const replyParams = (opts?: SendOptions) =>
    opts?.replyToMessageId ? { message_id: opts.replyToMessageId } : undefined;

  const sendMessage = async (chatId: string | number, text: string, options?: SendOptions): Promise<SentMessage> => {
    const html = renderMarkdownToTelegramHTML(text);
    const sent = await bot.api.sendMessage(chatId, html, {
      reply_parameters: replyParams(options),
      parse_mode: options?.parseMode ?? 'HTML',
    });
    return {
      messageId: sent.message_id,
      date: sent.date,
      text: sent.text ?? '',
      entities: convertGrammyEntities(sent.entities),
    };
  };

  const sendPhoto = async (chatId: string | number, photo: Buffer, options?: MediaSendOptions): Promise<SentMessage> => {
    const sent = await bot.api.sendPhoto(chatId, new InputFile(photo), {
      reply_parameters: replyParams(options),
      caption: options?.caption,
      parse_mode: options?.captionParseMode,
    });
    return {
      messageId: sent.message_id,
      date: sent.date,
      text: sent.caption ?? '',
      entities: convertGrammyEntities(sent.caption_entities),
    };
  };

  const sendDocument = async (chatId: string | number, document: Buffer, options?: MediaSendOptions): Promise<SentMessage> => {
    const inputFile = options?.fileName ? new InputFile(document, options.fileName) : new InputFile(document);
    const sent = await bot.api.sendDocument(chatId, inputFile, {
      reply_parameters: replyParams(options),
      caption: options?.caption,
      parse_mode: options?.captionParseMode,
    });
    return {
      messageId: sent.message_id,
      date: sent.date,
      text: sent.caption ?? '',
      entities: convertGrammyEntities(sent.caption_entities),
    };
  };

  const sendVideo = async (chatId: string | number, video: Buffer, options?: MediaSendOptions): Promise<SentMessage> => {
    const sent = await bot.api.sendVideo(chatId, new InputFile(video), {
      reply_parameters: replyParams(options),
      caption: options?.caption,
      parse_mode: options?.captionParseMode,
    });
    return {
      messageId: sent.message_id,
      date: sent.date,
      text: sent.caption ?? '',
      entities: convertGrammyEntities(sent.caption_entities),
    };
  };

  const sendAudio = async (chatId: string | number, audio: Buffer, options?: MediaSendOptions): Promise<SentMessage> => {
    const sent = await bot.api.sendAudio(chatId, new InputFile(audio), {
      reply_parameters: replyParams(options),
      caption: options?.caption,
      parse_mode: options?.captionParseMode,
    });
    return {
      messageId: sent.message_id,
      date: sent.date,
      text: sent.caption ?? '',
      entities: convertGrammyEntities(sent.caption_entities),
    };
  };

  const sendVoice = async (chatId: string | number, voice: Buffer, options?: MediaSendOptions): Promise<SentMessage> => {
    const sent = await bot.api.sendVoice(chatId, new InputFile(voice), {
      reply_parameters: replyParams(options),
      caption: options?.caption,
      parse_mode: options?.captionParseMode,
    });
    return {
      messageId: sent.message_id,
      date: sent.date,
      text: sent.caption ?? '',
      entities: convertGrammyEntities(sent.caption_entities),
    };
  };

  const sendAnimation = async (chatId: string | number, animation: Buffer, options?: MediaSendOptions): Promise<SentMessage> => {
    const sent = await bot.api.sendAnimation(chatId, new InputFile(animation), {
      reply_parameters: replyParams(options),
      caption: options?.caption,
      parse_mode: options?.captionParseMode,
    });
    return {
      messageId: sent.message_id,
      date: sent.date,
      text: sent.caption ?? '',
      entities: convertGrammyEntities(sent.caption_entities),
    };
  };

  const sendVideoNote = async (chatId: string | number, videoNote: Buffer, options?: MediaSendOptions): Promise<SentMessage> => {
    const sent = await bot.api.sendVideoNote(chatId, new InputFile(videoNote), {
      reply_parameters: replyParams(options),
    });
    return {
      messageId: sent.message_id,
      date: sent.date,
      text: '',
    };
  };

  const sendMediaGroup = async (chatId: string | number, media: MediaGroupItem[], options?: SendOptions): Promise<SentMessage[]> => {
    const inputMedia = media.map(item => {
      const file = item.fileName ? new InputFile(item.buffer, item.fileName) : new InputFile(item.buffer);
      switch (item.type) {
      case 'photo':
        return { type: 'photo', media: file, caption: item.caption, parse_mode: item.captionParseMode } as InputMediaPhoto;
      case 'video':
        return { type: 'video', media: file, caption: item.caption, parse_mode: item.captionParseMode } as InputMediaVideo;
      case 'audio':
        return { type: 'audio', media: file, caption: item.caption, parse_mode: item.captionParseMode } as InputMediaAudio;
      case 'document':
        return { type: 'document', media: file, caption: item.caption, parse_mode: item.captionParseMode } as InputMediaDocument;
      }
    });
    const sent = await bot.api.sendMediaGroup(chatId, inputMedia, {
      reply_parameters: replyParams(options),
    });
    return sent.map(msg => ({
      messageId: msg.message_id,
      date: msg.date,
      text: ('caption' in msg ? msg.caption : '') ?? '',
      entities: convertGrammyEntities('caption_entities' in msg ? msg.caption_entities : undefined),
    }));
  };

  return {
    start,
    stop,
    onMessage: messageBus.on,
    sendMessage,
    sendPhoto,
    sendDocument,
    sendVideo,
    sendAudio,
    sendVoice,
    sendAnimation,
    sendVideoNote,
    sendMediaGroup,
    downloadFile,
    raw: () => bot,
    botUserId: () => userId,
    botInfo: () => info,
  };
};
