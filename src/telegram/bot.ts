import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@guiiai/logg';
import * as tdl from 'tdl';
import type * as Td from 'tdlib-types';

import type { EntityCache } from './entity-cache';
import { createEntityCache } from './entity-cache';
import { createEventBus } from './event-bus';
import { hasRichOnlyMarkup, renderMarkdownToTelegramHTML } from './markdown';
import type { TelegramMessage } from './message';
import { fromTdMessage } from './message/tdlib';

export interface BotClientOptions {
  apiId: number;
  apiHash: string;
  token: string;
  databaseDirectory: string;
  filesDirectory: string;
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

export interface CustomEmojiInfo {
  customEmojiId: string;
  isAnimated: boolean;
  isVideo: boolean;
  setName?: string;
  setTitle?: string;
  download: () => Promise<Buffer>;
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
  sendChatAction(chatId: string | number, action?: 'typing'): Promise<void>;
  downloadMessageMedia(chatId: string, messageId: number): Promise<Buffer | undefined>;
  getStickerSetTitle(setIdOrName: string): Promise<string>;
  getCustomEmojiInfo(customEmojiIds: string[]): Promise<CustomEmojiInfo[]>;
  raw(): tdl.Client;
  entityCache(): EntityCache;
  botUserId(): string;
  botInfo(): BotInfo | undefined;
}

const parseMode = (mode: 'HTML' | 'MarkdownV2' | undefined): Td.TextParseMode$Input => {
  if (mode === 'MarkdownV2') return { _: 'textParseModeMarkdown', version: 2 };
  return { _: 'textParseModeHTML' };
};

const formattedFromHtml = (text: string, mode: 'HTML' | 'MarkdownV2' = 'HTML'): Td.formattedText$Input => {
  if (!text) return { _: 'formattedText', text: '', entities: [] };
  const result = tdl.execute({ _: 'parseTextEntities', text, parse_mode: parseMode(mode) });
  if (result && result._ === 'formattedText') {
    return { _: 'formattedText', text: result.text, entities: result.entities };
  }
  // parseTextEntities returned an error — fall back to plain text without entities.
  return { _: 'formattedText', text, entities: [] };
};

const writeTempBuffer = async (workDir: string, buffer: Buffer, fileName: string): Promise<string> => {
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = join(workDir, safeName);
  await writeFile(path, buffer);
  return path;
};

const findFileInContent = (content: Td.MessageContent): Td.file | undefined => {
  switch (content._) {
  case 'messagePhoto': {
    const sizes = content.photo.sizes;
    return [...sizes].sort((a, b) => b.width * b.height - a.width * a.height)[0]?.photo;
  }
  case 'messageDocument': return content.document.document;
  case 'messageVideo': return content.video.video;
  case 'messageAudio': return content.audio.audio;
  case 'messageVoiceNote': return content.voice_note.voice;
  case 'messageVideoNote': return content.video_note.video;
  case 'messageAnimation': return content.animation.animation;
  case 'messageSticker': return content.sticker.sticker;
  default: return undefined;
  }
};

export const createBotClient = (options: BotClientOptions, logger: Logger): BotClient => {
  const log = logger.withContext('telegram:bot');
  const cache = createEntityCache();

  const client = tdl.createClient({
    apiId: options.apiId,
    apiHash: options.apiHash,
    databaseDirectory: options.databaseDirectory,
    filesDirectory: options.filesDirectory,
    tdlibParameters: {
      device_model: 'Cahciua bot',
      application_version: '1.0',
      use_message_database: false,
      use_chat_info_database: true,
      use_secret_chats: false,
    },
  });

  client.on('error', err => { log.withError(err).error('tdl client error'); });

  const messageBus = createEventBus<TelegramMessage>('bot:message', log);

  const userId = options.token.split(':')[0]!;
  let info: BotInfo | undefined;

  client.on('update', (update: Td.Update) => {
    switch (update._) {
    case 'updateUser':
      cache.putUser(update.user);
      break;
    case 'updateNewChat':
      cache.putChat(update.chat);
      break;
    case 'updateNewMessage': {
      const msg = fromTdMessage(cache, update.message);
      if (msg) messageBus.emit({ ...msg, source: 'bot' });
      break;
    }
    }
  });

  const start = async () => {
    log.log('Starting bot...');
    await client.loginAsBot(options.token);
    const me = await client.invoke({ _: 'getMe' }) as Td.user;
    info = {
      id: me.id,
      firstName: me.first_name,
      username: me.usernames?.editable_username || me.usernames?.active_usernames?.[0],
    };
    log.withFields({ id: info.id, username: info.username, name: [me.first_name, me.last_name].filter(Boolean).join(' ') }).log('Bot authenticated');
  };

  const stop = async () => {
    log.log('Stopping bot...');
    await client.close();
    log.log('Bot stopped');
  };

  const sendMessage = async (chatId: string | number, text: string, opts?: SendOptions): Promise<SentMessage> => {
    // The caller passes markdown (LLM output). We render to Telegram-supported
    // HTML and then dispatch to either inputMessageRichMessage (for rich-only
    // features like math, headings, lists, tables) or inputMessageText (for
    // plain entity-style content that older clients can render correctly).
    const html = renderMarkdownToTelegramHTML(text);
    const replyTo: Td.InputMessageReplyTo$Input | undefined = opts?.replyToMessageId
      ? { _: 'inputMessageReplyToMessage', message_id: opts.replyToMessageId }
      : undefined;

    const content: Td.InputMessageContent$Input = hasRichOnlyMarkup(html)
      ? {
        _: 'inputMessageRichMessage',
        message: {
          _: 'inputRichMessage',
          source: { _: 'richMessageSourceHtml', text: html },
          is_rtl: false,
          detect_automatic_blocks: false,
        },
        clear_draft: true,
      }
      : {
        _: 'inputMessageText',
        text: formattedFromHtml(html, opts?.parseMode ?? 'HTML'),
        clear_draft: true,
      };

    const sent = await client.invoke({
      _: 'sendMessage',
      chat_id: Number(chatId),
      reply_to: replyTo,
      input_message_content: content,
    }) as Td.message;

    const sentText = sent.content._ === 'messageText'
      ? sent.content.text.text
      : sent.content._ === 'messageRichMessage'
        ? ''  // rich content doesn't reduce to plain text cleanly; downstream only uses the returned messageId.
        : '';
    return { messageId: sent.id, date: sent.date, text: sentText };
  };

  const sendFileGeneric = async (
    chatId: string | number,
    buffer: Buffer,
    kind: 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'video_note' | 'document',
    opts?: MediaSendOptions,
  ): Promise<SentMessage> => {
    const workDir = await mkdtemp(join(tmpdir(), 'cahciua-tdl-'));
    try {
      const fileName = opts?.fileName ?? `${kind}.bin`;
      const path = await writeTempBuffer(workDir, buffer, fileName);
      const inputFile: Td.InputFile$Input = { _: 'inputFileLocal', path };
      const caption = opts?.caption ? formattedFromHtml(opts.caption, opts.captionParseMode ?? 'HTML') : { _: 'formattedText' as const, text: '', entities: [] };

      let content: Td.InputMessageContent$Input;
      switch (kind) {
      case 'photo':
        content = { _: 'inputMessagePhoto', photo: { _: 'inputPhoto', photo: inputFile }, caption };
        break;
      case 'video':
        content = { _: 'inputMessageVideo', video: { _: 'inputVideo', video: inputFile, supports_streaming: true }, caption };
        break;
      case 'audio':
        content = { _: 'inputMessageAudio', audio: { _: 'inputAudio', audio: inputFile }, caption };
        break;
      case 'voice':
        content = { _: 'inputMessageVoiceNote', voice_note: inputFile, duration: 0, caption };
        break;
      case 'animation':
        content = { _: 'inputMessageAnimation', animation: { _: 'inputAnimation', animation: inputFile }, caption };
        break;
      case 'video_note':
        content = { _: 'inputMessageVideoNote', video_note: inputFile, duration: 0, length: 240 };
        break;
      case 'document':
      default:
        content = { _: 'inputMessageDocument', document: { _: 'inputDocument', document: inputFile, disable_content_type_detection: false }, caption };
        break;
      }

      const sent = await client.invoke({
        _: 'sendMessage',
        chat_id: Number(chatId),
        reply_to: opts?.replyToMessageId
          ? { _: 'inputMessageReplyToMessage', message_id: opts.replyToMessageId }
          : undefined,
        input_message_content: content,
      }) as Td.message;
      const captionText = 'caption' in sent.content && sent.content.caption ? sent.content.caption.text : '';
      return { messageId: sent.id, date: sent.date, text: captionText };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const sendPhoto = (c: string | number, b: Buffer, o?: MediaSendOptions) => sendFileGeneric(c, b, 'photo', o);
  const sendDocument = (c: string | number, b: Buffer, o?: MediaSendOptions) => sendFileGeneric(c, b, 'document', o);
  const sendVideo = (c: string | number, b: Buffer, o?: MediaSendOptions) => sendFileGeneric(c, b, 'video', o);
  const sendAudio = (c: string | number, b: Buffer, o?: MediaSendOptions) => sendFileGeneric(c, b, 'audio', o);
  const sendVoice = (c: string | number, b: Buffer, o?: MediaSendOptions) => sendFileGeneric(c, b, 'voice', o);
  const sendAnimation = (c: string | number, b: Buffer, o?: MediaSendOptions) => sendFileGeneric(c, b, 'animation', o);
  const sendVideoNote = (c: string | number, b: Buffer, o?: MediaSendOptions) => sendFileGeneric(c, b, 'video_note', o);

  const sendMediaGroup = async (chatId: string | number, media: MediaGroupItem[], opts?: SendOptions): Promise<SentMessage[]> => {
    const workDir = await mkdtemp(join(tmpdir(), 'cahciua-tdl-'));
    try {
      const contents = await Promise.all(media.map(async (m, i): Promise<Td.InputMessageContent$Input> => {
        const fileName = m.fileName ?? `${m.type}-${i}.bin`;
        const path = await writeTempBuffer(workDir, m.buffer, fileName);
        const inputFile: Td.InputFile$Input = { _: 'inputFileLocal', path };
        const caption = m.caption ? formattedFromHtml(m.caption, m.captionParseMode ?? 'HTML') : { _: 'formattedText' as const, text: '', entities: [] };
        switch (m.type) {
        case 'photo': return { _: 'inputMessagePhoto', photo: { _: 'inputPhoto', photo: inputFile }, caption };
        case 'video': return { _: 'inputMessageVideo', video: { _: 'inputVideo', video: inputFile, supports_streaming: true }, caption };
        case 'audio': return { _: 'inputMessageAudio', audio: { _: 'inputAudio', audio: inputFile }, caption };
        case 'document':
        default: return { _: 'inputMessageDocument', document: { _: 'inputDocument', document: inputFile, disable_content_type_detection: false }, caption };
        }
      }));

      const result = await client.invoke({
        _: 'sendMessageAlbum',
        chat_id: Number(chatId),
        reply_to: opts?.replyToMessageId
          ? { _: 'inputMessageReplyToMessage', message_id: opts.replyToMessageId }
          : undefined,
        input_message_contents: contents,
      }) as Td.messages;
      return result.messages.flatMap((m): SentMessage[] => m ? [{ messageId: m.id, date: m.date, text: 'caption' in m.content && m.content.caption ? m.content.caption.text : '' }] : []);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const sendChatAction = async (chatId: string | number, action: 'typing' = 'typing') => {
    void action;
    await client.invoke({
      _: 'sendChatAction',
      chat_id: Number(chatId),
      action: { _: 'chatActionTyping' },
    });
  };

  const waitForFileDownload = async (fileId: number, timeoutMs = 60000): Promise<Td.file> => {
    // tdlib's `synchronous: true` flag returns once the download succeeds, fails, or
    // is canceled; that's what we want for our blocking download API.
    const result = await Promise.race([
      client.invoke({ _: 'downloadFile', file_id: fileId, priority: 1, offset: 0, limit: 0, synchronous: true }) as Promise<Td.file>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Download timeout')), timeoutMs)),
    ]);
    if (!result.local.is_downloading_completed)
      throw new Error(`File ${fileId} did not finish downloading`);
    return result;
  };

  const downloadMessageMedia = async (chatId: string, messageId: number): Promise<Buffer | undefined> => {
    const msg = await client.invoke({ _: 'getMessage', chat_id: Number(chatId), message_id: messageId }) as Td.message;
    const file = findFileInContent(msg.content);
    if (!file) return undefined;
    const downloaded = await waitForFileDownload(file.id);
    const fs = await import('node:fs/promises');
    return await fs.readFile(downloaded.local.path);
  };

  const getStickerSetTitle = async (setIdOrName: string): Promise<string> => {
    if (/^-?\d+$/.test(setIdOrName)) {
      const set = await client.invoke({ _: 'getStickerSet', set_id: setIdOrName }) as Td.stickerSet;
      return set.title;
    }
    const set = await client.invoke({ _: 'searchStickerSet', name: setIdOrName }) as Td.stickerSet;
    return set.title;
  };

  const getCustomEmojiInfo = async (customEmojiIds: string[]): Promise<CustomEmojiInfo[]> => {
    if (customEmojiIds.length === 0) return [];
    const stickers = await client.invoke({
      _: 'getCustomEmojiStickers',
      custom_emoji_ids: customEmojiIds,
    }) as Td.stickers;
    return stickers.stickers.flatMap((s): CustomEmojiInfo[] => {
      if (s.full_type._ !== 'stickerFullTypeCustomEmoji') return [];
      const setIdStr = String(s.set_id);
      const stickerFile = s.sticker;
      return [{
        customEmojiId: String(s.id),
        isAnimated: s.format._ === 'stickerFormatTgs',
        isVideo: s.format._ === 'stickerFormatWebm',
        setName: setIdStr !== '0' ? setIdStr : undefined,
        download: async () => {
          const downloaded = await waitForFileDownload(stickerFile.id);
          const fs = await import('node:fs/promises');
          return await fs.readFile(downloaded.local.path);
        },
      }];
    });
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
    sendChatAction,
    downloadMessageMedia,
    getStickerSetTitle,
    getCustomEmojiInfo,
    raw: () => client,
    entityCache: () => cache,
    botUserId: () => userId,
    botInfo: () => info,
  };
};
