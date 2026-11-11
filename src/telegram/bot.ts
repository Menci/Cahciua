import type { Logger } from '@guiiai/logg';
import bigInt from 'big-integer';
import { Api, Rich, TelegramClient } from 'teleproto';
import { NewMessage } from 'teleproto/events';
import { HTMLParser } from 'teleproto/extensions/html';
import { StoreSession, StringSession } from 'teleproto/sessions';

import { createEventBus } from './event-bus';
import { captureIngressMetadata } from './ingress-meta';
import { decideLinkPreviewOptions } from './link-preview';
import { hasRichOnlyMarkup, renderMarkdownToTelegramHTML } from './markdown';
import type { TelegramMessage } from './message';
import { fromTeleprotoMessage } from './message/teleproto';
import { createChatPeerResolver } from './peer';
import { createTeleprotoLogger } from './teleproto-logger';

export interface BotClientOptions {
  apiId: number;
  apiHash: string;
  token: string;
  sessionPath: string;
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
  format: 'static' | 'animated' | 'video';
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
  sendChatAction(chatId: string | number): Promise<void>;
  setMessageReaction(chatId: string | number, messageId: number, emoji: string | undefined): Promise<void>;
  downloadMessageMedia(chatId: string, messageId: number): Promise<Buffer | undefined>;
  getCustomEmojiInfo(customEmojiIds: string[]): Promise<CustomEmojiInfo[]>;
  raw(): TelegramClient;
  botUserId(): string;
  botInfo(): BotInfo | undefined;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g)$/i;

/**
 * teleproto decides photo-vs-document purely from the file name extension and
 * only recognizes png/jpg/jpeg, so an image without one of those suffixes would
 * be sent as a document. Callers supply names for display, not for typing.
 */
const photoFileName = (fileName: string | undefined): string =>
  fileName && IMAGE_EXTENSIONS.test(fileName) ? fileName : 'photo.jpg';

const namedBuffer = (buffer: Buffer, fileName: string): Buffer => {
  Object.defineProperty(buffer, 'name', { value: fileName, enumerable: true });
  return buffer;
};

const captionParseMode = (mode: 'HTML' | 'MarkdownV2' | undefined): 'html' | 'md' =>
  mode === 'MarkdownV2' ? 'md' : 'html';

const toSent = (message: Api.Message): SentMessage => ({
  messageId: message.id,
  date: message.date,
  text: message.message,
});

const richMessageFor = (html: string): RichContentInput | undefined =>
  hasRichOnlyMarkup(html) ? Rich.html(html) : undefined;

type RichContentInput = Api.TypeInputRichMessage;

export const createBotClient = (options: BotClientOptions, logger: Logger): BotClient => {
  const log = logger.withContext('telegram:bot');
  const client = new TelegramClient(options.sessionPath ? new StoreSession(options.sessionPath) : new StringSession(''), options.apiId, options.apiHash, {
    connectionRetries: 3,
    catchUp: false,
    baseLogger: createTeleprotoLogger(log),
  });
  const resolveChatPeer = createChatPeerResolver(client);
  const messageBus = createEventBus<TelegramMessage>('bot:message', log);
  const userId = options.token.split(':')[0]!;
  let info: BotInfo | undefined;

  const start = async () => {
    log.log('Starting bot...');
    await client.start({ botAuthToken: options.token });
    const me = await client.getMe();
    info = {
      id: Number(me.id),
      firstName: me.firstName ?? 'Bot',
      username: me.username === '' ? undefined : me.username,
    };
    client.addEventHandler(event => {
      if (!event.message) return;
      const message = fromTeleprotoMessage(event.message, 'bot');
      if (message) messageBus.emit(captureIngressMetadata(message));
    }, new NewMessage({}));
    log.withFields({
      id: info.id,
      username: info.username,
      name: [me.firstName, me.lastName].filter(Boolean).join(' '),
    }).log('Bot authenticated');
  };

  const stop = async () => {
    log.log('Stopping bot...');
    await client.destroy();
    log.log('Bot stopped');
  };

  const sendMessage = async (chatId: string | number, text: string, opts?: SendOptions): Promise<SentMessage> => {
    const html = renderMarkdownToTelegramHTML(text);
    const richMessage = richMessageFor(html);
    const prepared = richMessage
      ? { richMessage }
      : { message: html, parseMode: 'html' as const };
    const [plainText, entities] = richMessage ? [html, []] : HTMLParser.parse(html);
    const sent = await client.sendMessage(await resolveChatPeer(chatId), {
      ...prepared,
      replyTo: opts?.replyToMessageId,
      ...decideLinkPreviewOptions(plainText, entities, String(chatId)),
    });
    return toSent(sent);
  };

  const sendMedia = async (
    chatId: string | number,
    buffer: Buffer,
    kind: 'photo' | 'video' | 'audio' | 'document',
    opts?: MediaSendOptions,
  ): Promise<SentMessage> => {
    const fileName = kind === 'photo'
      ? photoFileName(opts?.fileName)
      : opts?.fileName ?? `${kind}.bin`;
    const sent = await client.sendFile(await resolveChatPeer(chatId), {
      file: namedBuffer(buffer, fileName),
      caption: opts?.caption,
      parseMode: captionParseMode(opts?.captionParseMode),
      replyTo: opts?.replyToMessageId,
      forceDocument: kind === 'document',
    });
    return toSent(sent);
  };

  const sendPhoto = (c: string | number, b: Buffer, o?: MediaSendOptions) => sendMedia(c, b, 'photo', o);
  const sendDocument = (c: string | number, b: Buffer, o?: MediaSendOptions) => sendMedia(c, b, 'document', o);
  const sendVideo = (c: string | number, b: Buffer, o?: MediaSendOptions) => sendMedia(c, b, 'video', o);
  const sendAudio = (c: string | number, b: Buffer, o?: MediaSendOptions) => sendMedia(c, b, 'audio', o);

  const sendVoice = async (c: string | number, b: Buffer, o?: MediaSendOptions): Promise<SentMessage> =>
    toSent(await client.sendFile(await resolveChatPeer(c), {
      file: namedBuffer(b, o?.fileName ?? 'voice.ogg'),
      caption: o?.caption,
      parseMode: captionParseMode(o?.captionParseMode),
      replyTo: o?.replyToMessageId,
      voiceNote: true,
    }));

  const sendAnimation = async (c: string | number, b: Buffer, o?: MediaSendOptions): Promise<SentMessage> =>
    toSent(await client.sendFile(await resolveChatPeer(c), {
      file: namedBuffer(b, o?.fileName ?? 'animation.mp4'),
      caption: o?.caption,
      parseMode: captionParseMode(o?.captionParseMode),
      replyTo: o?.replyToMessageId,
      attributes: [new Api.DocumentAttributeAnimated()],
    }));

  const sendVideoNote = async (c: string | number, b: Buffer, o?: MediaSendOptions): Promise<SentMessage> =>
    toSent(await client.sendFile(await resolveChatPeer(c), {
      file: namedBuffer(b, o?.fileName ?? 'video-note.mp4'),
      replyTo: o?.replyToMessageId,
      videoNote: true,
    }));

  const sendMediaGroup = async (chatId: string | number, media: MediaGroupItem[], opts?: SendOptions): Promise<SentMessage[]> => {
    const sent = await client.sendFile(await resolveChatPeer(chatId), {
      file: media.map((item, index) => namedBuffer(
        item.buffer,
        item.type === 'photo'
          ? photoFileName(item.fileName)
          : item.fileName ?? `${item.type}-${index}.bin`,
      )),
      caption: media.map(item => item.caption ?? ''),
      parseMode: captionParseMode(media[0]?.captionParseMode),
      replyTo: opts?.replyToMessageId,
    });
    const messages = Array.isArray(sent) ? sent : [sent];
    return messages.map(toSent);
  };

  const sendChatAction = async (chatId: string | number) => {
    await client.setTyping(await resolveChatPeer(chatId));
  };

  const setMessageReaction = async (chatId: string | number, messageId: number, emoji: string | undefined) => {
    await client.sendReaction(
      await resolveChatPeer(chatId),
      messageId,
      emoji ? [new Api.ReactionEmoji({ emoticon: emoji })] : [],
    );
  };

  const downloadMessageMedia = async (chatId: string, messageId: number): Promise<Buffer | undefined> => {
    const messages = await client.getMessages(await resolveChatPeer(chatId), { ids: [messageId] });
    const message = messages[0];
    if (!message || !(message instanceof Api.Message) || !message.media) return undefined;
    const result = await client.downloadMedia(message, {});
    return Buffer.isBuffer(result) ? result : undefined;
  };

  const getCustomEmojiInfo = async (customEmojiIds: string[]): Promise<CustomEmojiInfo[]> => {
    if (customEmojiIds.length === 0) return [];
    const documents = await client.getCustomEmojiDocuments(customEmojiIds.map(id => bigInt(id)));
    return documents.flatMap((document): CustomEmojiInfo[] => {
      if (!(document instanceof Api.Document)) return [];
      return [{
        customEmojiId: String(document.id),
        format: document.mimeType === 'application/x-tgsticker'
          ? 'animated' : document.mimeType === 'video/webm' ? 'video' : 'static',
        download: async () => {
          const media = new Api.MessageMediaDocument({ document });
          const result = await client.downloadMedia(media, {});
          if (!Buffer.isBuffer(result)) throw new Error(`Failed to download custom emoji ${document.id}`);
          return result;
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
    setMessageReaction,
    downloadMessageMedia,
    getCustomEmojiInfo,
    raw: () => client,
    botUserId: () => userId,
    botInfo: () => info,
  };
};
