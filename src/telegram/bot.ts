import type { Logger } from '@guiiai/logg';
import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { CustomFile } from 'telegram/client/uploads';
import { NewMessage, type NewMessageEvent } from 'telegram/events';
import { StringSession } from 'telegram/sessions';

import { createEventBus } from './event-bus';
import { createGramjsLogger } from './gramjs-logger';
import { renderMarkdownToTelegramHTML } from './markdown';
import type { TelegramMessage } from './message';
import { fromGramjsAnyMessage } from './message';

export interface BotClientOptions {
  apiId: number;
  apiHash: string;
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
  getStickerSetTitle(setName: string): Promise<string>;
  getCustomEmojiInfo(customEmojiIds: string[]): Promise<CustomEmojiInfo[]>;
  raw(): TelegramClient;
  botUserId(): string;
  botInfo(): BotInfo | undefined;
}

const toCaption = (caption: string | undefined, mode: 'HTML' | 'MarkdownV2' | undefined): string | undefined => {
  if (!caption) return undefined;
  if (mode === 'HTML') return caption;
  return caption;
};

const buildAttributes = (kind: MediaGroupItem['type'] | 'voice' | 'video_note' | 'animation', fileName?: string): Api.TypeDocumentAttribute[] => {
  const attrs: Api.TypeDocumentAttribute[] = [];
  if (fileName) attrs.push(new Api.DocumentAttributeFilename({ fileName }));
  if (kind === 'voice') {
    attrs.push(new Api.DocumentAttributeAudio({ voice: true, duration: 0 }));
  } else if (kind === 'video_note') {
    attrs.push(new Api.DocumentAttributeVideo({ roundMessage: true, supportsStreaming: false, duration: 0, w: 0, h: 0 }));
  } else if (kind === 'animation') {
    attrs.push(new Api.DocumentAttributeAnimated());
  }
  return attrs;
};

export const createBotClient = (options: BotClientOptions, logger: Logger): BotClient => {
  const log = logger.withContext('telegram:bot');
  const session = new StringSession('');
  const client = new TelegramClient(session, options.apiId, options.apiHash, {
    connectionRetries: 3,
    baseLogger: createGramjsLogger(log),
  });

  const messageBus = createEventBus<TelegramMessage>('bot:message', log);

  const userId = options.token.split(':')[0]!;
  let info: BotInfo | undefined;

  const start = async () => {
    log.log('Starting bot...');
    await client.start({
      botAuthToken: options.token,
      onError: err => { log.withError(err).error('Bot login error'); },
    });

    const me = await client.getMe();
    if (me instanceof Api.User) {
      info = {
        id: me.id.toJSNumber(),
        firstName: me.firstName ?? 'Bot',
        username: me.username,
      };
      log.withFields({
        id: info.id,
        username: info.username,
        name: [me.firstName, me.lastName].filter(Boolean).join(' '),
      }).log('Bot authenticated');
    }

    client.addEventHandler(
      (event: NewMessageEvent) => {
        if (!event.message || event.message instanceof Api.MessageEmpty) return;
        const msg = fromGramjsAnyMessage(event.message);
        if (msg) {
          // Stamp source so downstream identifies bot-side ingress (used only when
          // userbot is absent — see TelegramManager).
          messageBus.emit({ ...msg, source: 'bot' });
        }
      },
      new NewMessage({}),
    );
  };

  const stop = async () => {
    log.log('Stopping bot...');
    await client.destroy();
    log.log('Bot stopped');
  };

  const renderForSend = (text: string, parseMode: 'HTML' | 'MarkdownV2' | undefined): { content: string; parseMode: 'html' | 'md' | undefined } => {
    if (parseMode === 'MarkdownV2') return { content: text, parseMode: 'md' };
    return { content: renderMarkdownToTelegramHTML(text), parseMode: 'html' };
  };

  const sendMessage = async (chatId: string | number, text: string, opts?: SendOptions): Promise<SentMessage> => {
    const { content, parseMode } = renderForSend(text, opts?.parseMode ?? 'HTML');
    const sent = await client.sendMessage(String(chatId), {
      message: content,
      parseMode,
      replyTo: opts?.replyToMessageId,
    });
    return {
      messageId: sent.id,
      date: sent.date,
      text: sent.message ?? '',
    };
  };

  const sendFileGeneric = async (
    chatId: string | number,
    buffer: Buffer,
    kind: 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'video_note' | 'document',
    opts?: MediaSendOptions,
  ): Promise<SentMessage> => {
    const captionMode = opts?.captionParseMode;
    const file = new CustomFile(opts?.fileName ?? `${kind}.bin`, buffer.length, '', buffer);
    const sent = await client.sendFile(String(chatId), {
      file,
      caption: toCaption(opts?.caption, captionMode),
      parseMode: captionMode === 'MarkdownV2' ? 'md' : 'html',
      replyTo: opts?.replyToMessageId,
      forceDocument: kind === 'document',
      voiceNote: kind === 'voice',
      videoNote: kind === 'video_note',
      attributes: buildAttributes(kind, opts?.fileName),
    });
    return {
      messageId: sent.id,
      date: sent.date,
      text: sent.message ?? '',
    };
  };

  const sendPhoto = (chatId: string | number, photo: Buffer, opts?: MediaSendOptions) =>
    sendFileGeneric(chatId, photo, 'photo', opts);
  const sendDocument = (chatId: string | number, document: Buffer, opts?: MediaSendOptions) =>
    sendFileGeneric(chatId, document, 'document', opts);
  const sendVideo = (chatId: string | number, video: Buffer, opts?: MediaSendOptions) =>
    sendFileGeneric(chatId, video, 'video', opts);
  const sendAudio = (chatId: string | number, audio: Buffer, opts?: MediaSendOptions) =>
    sendFileGeneric(chatId, audio, 'audio', opts);
  const sendVoice = (chatId: string | number, voice: Buffer, opts?: MediaSendOptions) =>
    sendFileGeneric(chatId, voice, 'voice', opts);
  const sendAnimation = (chatId: string | number, animation: Buffer, opts?: MediaSendOptions) =>
    sendFileGeneric(chatId, animation, 'animation', opts);
  const sendVideoNote = (chatId: string | number, videoNote: Buffer, opts?: MediaSendOptions) =>
    sendFileGeneric(chatId, videoNote, 'video_note', opts);

  const sendMediaGroup = async (chatId: string | number, media: MediaGroupItem[], opts?: SendOptions): Promise<SentMessage[]> => {
    const files = media.map(m => new CustomFile(m.fileName ?? `${m.type}.bin`, m.buffer.length, '', m.buffer));
    const captions = media.map(m => toCaption(m.caption, m.captionParseMode) ?? '');
    const sent = await client.sendFile(String(chatId), {
      file: files,
      caption: captions,
      parseMode: media[0]?.captionParseMode === 'MarkdownV2' ? 'md' : 'html',
      replyTo: opts?.replyToMessageId,
    });
    const arr = Array.isArray(sent) ? sent : [sent];
    return arr.map(msg => ({
      messageId: msg.id,
      date: msg.date,
      text: msg.message ?? '',
    }));
  };

  const sendChatAction = async (chatId: string | number, action: 'typing' = 'typing') => {
    const peer = await client.getInputEntity(String(chatId));
    await client.invoke(new Api.messages.SetTyping({
      peer,
      action: action === 'typing'
        ? new Api.SendMessageTypingAction()
        : new Api.SendMessageTypingAction(),
    }));
  };

  const downloadMessageMedia = async (chatId: string, messageId: number): Promise<Buffer | undefined> => {
    const msgs = await client.getMessages(String(chatId), { ids: [messageId] });
    const msg = msgs[0];
    if (!msg || msg instanceof Api.MessageEmpty || !msg.media) return undefined;
    const result = await client.downloadMedia(msg, {});
    return Buffer.isBuffer(result) ? result : undefined;
  };

  const getStickerSetTitle = async (setName: string): Promise<string> => {
    const result = await client.invoke(new Api.messages.GetStickerSet({
      stickerset: new Api.InputStickerSetShortName({ shortName: setName }),
      hash: 0,
    }));
    if (result instanceof Api.messages.StickerSet) return result.set.title;
    throw new Error(`Unexpected sticker set response for "${setName}"`);
  };

  const getCustomEmojiInfo = async (customEmojiIds: string[]): Promise<CustomEmojiInfo[]> => {
    if (customEmojiIds.length === 0) return [];
    const documentIds = customEmojiIds.map(id => bigInt(id));
    const result = await client.invoke(new Api.messages.GetCustomEmojiDocuments({ documentId: documentIds }));
    const out: CustomEmojiInfo[] = [];
    for (const doc of result) {
      if (!(doc instanceof Api.Document)) continue;
      const stickerAttr = doc.attributes.find(
        (a): a is Api.DocumentAttributeSticker => a instanceof Api.DocumentAttributeSticker,
      );
      const videoAttr = doc.attributes.find(a => a instanceof Api.DocumentAttributeVideo);
      const isAnimated = doc.mimeType === 'application/x-tgsticker';
      const isVideo = videoAttr != null;
      const setName = stickerAttr?.stickerset instanceof Api.InputStickerSetShortName
        ? stickerAttr.stickerset.shortName
        : undefined;
      const documentRef = doc;
      out.push({
        customEmojiId: doc.id.toString(),
        isAnimated,
        isVideo,
        setName,
        download: async () => {
          // gramjs's downloadMedia accepts a MessageMedia wrapper around the document.
          const media = new Api.MessageMediaDocument({ document: documentRef });
          const buf = await client.downloadMedia(media, {});
          if (!Buffer.isBuffer(buf)) throw new Error(`Failed to download custom emoji document ${doc.id.toString()}`);
          return buf;
        },
      });
    }
    return out;
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
    botUserId: () => userId,
    botInfo: () => info,
  };
};
