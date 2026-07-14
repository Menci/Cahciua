import { mkdirSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';

import type { BotClient, CustomEmojiInfo, MediaGroupItem, MediaSendOptions, SendOptions, SentMessage } from './bot';
import { createBotClient } from './bot';
import { createEventBus } from './event-bus';
import { captureIngressMetadata } from './ingress-meta';
import type { IngressTelegramMessage, IngressTelegramMessageDelete, IngressTelegramMessageEdit } from './ingress-meta';
import type { Attachment, MessageEntity, TelegramMessage } from './message';
import { resolveMessageMetadata } from './message/resolve-metadata';
import { createSessionIngressQueue } from './session-ingress-queue';
import type { TypingEvent, UserbotClient } from './userbot';
import { createUserbotClient } from './userbot';
import type { AnimationToTextResolver } from '../media/animation-to-text';
import type { CustomEmojiToTextResolver } from '../media/custom-emoji-to-text';
import { canExtractFrames, extractFrames } from '../media/frame-extractor';
import type { ImageToTextResolver } from '../media/image-to-text';
import { canGenerateThumbnail, generateThumbnail } from '../media/thumbnail';

export interface TelegramClientOptions {
  apiId: number;
  apiHash: string;
  botToken: string;
  userbotEnabled: boolean;
  botDataDir: string;
  userbotDataDir: string;
}

export interface TelegramClients {
  bot: BotClient;
  userbot?: UserbotClient;
}

export interface TelegramManagerOptions {
  initialChatIds: readonly string[];
  imageToTextResolvers: ReadonlyMap<string, ImageToTextResolver>;
  animationToTextResolvers: ReadonlyMap<string, AnimationToTextResolver>;
  animationMaxFrames: ReadonlyMap<string, number>;
  customEmojiToTextResolvers: ReadonlyMap<string, CustomEmojiToTextResolver>;
}

type IngressEvent =
  | { kind: 'message'; chatId: string; message: IngressTelegramMessage }
  | { kind: 'edit'; chatId: string; edit: IngressTelegramMessageEdit }
  | { kind: 'delete'; chatId: string; del: IngressTelegramMessageDelete };

export interface TelegramManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage: (handler: (msg: IngressTelegramMessage) => void) => void;
  onMessageEdit: (handler: (edit: IngressTelegramMessageEdit) => void) => void;
  onMessageDelete: (handler: (del: IngressTelegramMessageDelete) => void) => void;
  onTyping: (handler: (typing: TypingEvent) => void) => void;
  startTypingPolling(chatId: string): void;
  stopTypingPolling(chatId: string): void;
  sendChatAction(chatId: string | number): Promise<void>;
  setMessageReaction(chatId: string | number, messageId: number, emoji: string | undefined): Promise<void>;
  sendMessage(chatId: string | number, text: string, options?: SendOptions): Promise<SentMessage>;
  sendPhoto(chatId: string | number, photo: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendDocument(chatId: string | number, document: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendVideo(chatId: string | number, video: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendAudio(chatId: string | number, audio: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendVoice(chatId: string | number, voice: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendAnimation(chatId: string | number, animation: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendVideoNote(chatId: string | number, videoNote: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendMediaGroup(chatId: string | number, media: MediaGroupItem[], options?: SendOptions): Promise<SentMessage[]>;
  downloadMessageMedia(chatId: string, messageId: number): Promise<Buffer | undefined>;
  getCustomEmojiInfo(customEmojiIds: string[]): Promise<CustomEmojiInfo[]>;
  bot: BotClient;
  userbot?: UserbotClient;
}

export const createTelegramClients = (
  options: TelegramClientOptions,
  logger: Logger,
): TelegramClients => {
  mkdirSync(options.botDataDir, { recursive: true });
  if (options.userbotEnabled) mkdirSync(options.userbotDataDir, { recursive: true });

  const bot = createBotClient({
    apiId: options.apiId,
    apiHash: options.apiHash,
    token: options.botToken,
    databaseDirectory: `${options.botDataDir}/db`,
    filesDirectory: `${options.botDataDir}/files`,
  }, logger);
  const userbot = options.userbotEnabled
    ? createUserbotClient({
        apiId: options.apiId,
        apiHash: options.apiHash,
        databaseDirectory: `${options.userbotDataDir}/db`,
        filesDirectory: `${options.userbotDataDir}/files`,
      }, logger)
    : undefined;
  return { bot, userbot };
};

export const createTelegramManager = (
  options: TelegramManagerOptions,
  clients: TelegramClients,
  logger: Logger,
): TelegramManager => {
  const log = logger.withContext('telegram:manager');
  const { bot, userbot } = clients;

  const botChats = new Set<string>(options.initialChatIds);
  const messageBus = createEventBus<IngressTelegramMessage>('telegram:message', logger, true);
  const editBus = createEventBus<IngressTelegramMessageEdit>('telegram:edit', logger, true);
  const deleteBus = createEventBus<IngressTelegramMessageDelete>('telegram:delete', logger, true);
  const typingBus = createEventBus<TypingEvent>('telegram:typing', logger);

  const downloadMessageMedia = async (chatId: string, messageId: number): Promise<Buffer | undefined> => {
    if (userbot) {
      const buf = await userbot.downloadMessageMedia(chatId, messageId);
      if (buf) return buf;
    }
    return await bot.downloadMessageMedia(chatId, messageId);
  };

  const hydrateAttachments = async (
    chatId: string,
    messageId: number,
    text: string,
    attachments?: Attachment[],
    entities?: MessageEntity[],
  ) => {
    const imageToText = options.imageToTextResolvers.get(chatId);
    const animationToText = options.animationToTextResolvers.get(chatId);
    const customEmojiToText = options.customEmojiToTextResolvers.get(chatId);
    if (attachments) {
      const originalBuffers = new Map<Attachment, Buffer>();
      await Promise.all(attachments.map(async att => {
        if (att.thumbnailWebp || !canGenerateThumbnail(att)) return;
        try {
          const buffer = await downloadMessageMedia(chatId, messageId);
          if (buffer) {
            originalBuffers.set(att, buffer);
            att.thumbnailWebp = await generateThumbnail(buffer);
          }
        } catch (error) {
          if (imageToText) throw error;
          log.withError(error).warn('Failed to generate thumbnail');
        }
      }));

      if (imageToText) {
        await Promise.all(attachments.map(async att => {
          if (!att.thumbnailWebp) return;
          const thumbnailBuffer = Buffer.from(att.thumbnailWebp, 'base64');
          const highResBuffer = originalBuffers.get(att);
          await imageToText.resolve(thumbnailBuffer, text, highResBuffer);
        }));
      }

      if (animationToText) {
        const maxFrames = options.animationMaxFrames.get(chatId);
        if (maxFrames == null) throw new Error(`Missing animation maxFrames for chat ${chatId}`);
        await Promise.all(attachments.map(async att => {
          if (!canExtractFrames(att)) return;
          const buffer = await downloadMessageMedia(chatId, messageId);
          if (!buffer) throw new Error('Failed to download animation for blocking transform');
          const { frames, cacheKey, frameTimestamps } = await extractFrames(buffer, att, maxFrames);
          att.animationHash = cacheKey;
          await animationToText.resolve({
            cacheKey,
            frames,
            caption: text,
            isSticker: att.type === 'sticker',
            emoji: att.emoji,
            stickerSetName: att.stickerSetName,
            duration: att.duration,
            frameTimestamps,
          });
        }));
      }
    }

    if (customEmojiToText && entities) {
      const items = entities.flatMap(ent => {
        if (ent.type !== 'custom_emoji') return [];
        if (!ent.customEmojiId) throw new Error('Custom emoji entity has no ID');
        return [{
          customEmojiId: ent.customEmojiId,
          fallbackEmoji: text.substring(ent.offset, ent.offset + ent.length),
          stickerSetName: ent.customEmojiSetName,
        }];
      });
      if (items.length > 0) {
        await customEmojiToText.resolve(items);
      }
    }
  };

  const ingressQueue = createSessionIngressQueue<IngressEvent>({
    logger,
    transform: async event => {
      switch (event.kind) {
      case 'message':
        await resolveMessageMetadata(userbot?.raw() ?? bot.raw(), event.message);
        await hydrateAttachments(event.chatId, event.message.messageId, event.message.text, event.message.attachments, event.message.entities);
        return event;
      case 'edit':
        await resolveMessageMetadata(userbot?.raw() ?? bot.raw(), event.edit);
        await hydrateAttachments(event.chatId, event.edit.messageId, event.edit.text, event.edit.attachments, event.edit.entities);
        return event;
      case 'delete':
        return event;
      }
    },
    commit: event => {
      switch (event.kind) {
      case 'message':
        messageBus.emit(event.message);
        break;
      case 'edit':
        editBus.emit(event.edit);
        break;
      case 'delete':
        deleteBus.emit(event.del);
        break;
      }
    },
  });

  const ingestMessage = (msg: TelegramMessage) => {
    botChats.add(msg.chatId);
    const enriched = captureIngressMetadata(msg);
    ingressQueue.enqueue({ kind: 'message', chatId: enriched.chatId, message: enriched });
  };

  const handleTypingEvent = (typing: TypingEvent) => {
    if (!botChats.has(typing.chatId)) return;
    logger.withFields({ chatId: typing.chatId, userId: typing.userId }).debug('Telegram typing event received');
    typingBus.emit(typing);
  };

  if (userbot) {
    userbot.onMessage(ingestMessage);

    userbot.onMessageEdit(edit => {
      if (!botChats.has(edit.chatId)) return;
      ingressQueue.enqueue({
        kind: 'edit',
        chatId: edit.chatId,
        edit: captureIngressMetadata(edit),
      });
    });

    userbot.onMessageDelete(del => {
      if (!del.chatId) throw new Error('TDLib delete update is missing chatId');
      const chatId = del.chatId;
      if (!botChats.has(chatId)) return;
      ingressQueue.enqueue({
        kind: 'delete',
        chatId,
        del: captureIngressMetadata({ ...del, chatId }),
      });
    });

    userbot.onTyping(handleTypingEvent);
  } else {
    bot.onMessage(ingestMessage);
  }

  // openChat makes TDLib deliver updateChatAction reliably for large supergroups.
  const startTypingPolling = (chatId: string) => {
    if (!userbot) return;
    void userbot.openChat(chatId).catch(err => log.withError(err).withFields({ chatId }).warn('openChat failed'));
  };
  const stopTypingPolling = (chatId: string) => {
    if (!userbot) return;
    void userbot.closeChat(chatId).catch(err => log.withError(err).withFields({ chatId }).warn('closeChat failed'));
  };

  const start = async () => {
    await Promise.all([
      bot.start(),
      userbot?.start(),
    ]);
  };

  const stop = async () => {
    await Promise.all([
      bot.stop(),
      userbot?.stop(),
    ]);
  };

  return {
    start,
    stop,
    onMessage: messageBus.on,
    onMessageEdit: editBus.on,
    onMessageDelete: deleteBus.on,
    onTyping: typingBus.on,
    startTypingPolling,
    stopTypingPolling,
    sendMessage: (chatId, text, opts) => bot.sendMessage(chatId, text, opts),
    sendChatAction: chatId => bot.sendChatAction(chatId),
    setMessageReaction: (chatId, messageId, emoji) => bot.setMessageReaction(chatId, messageId, emoji),
    sendPhoto: (chatId, photo, opts) => bot.sendPhoto(chatId, photo, opts),
    sendDocument: (chatId, doc, opts) => bot.sendDocument(chatId, doc, opts),
    sendVideo: (chatId, video, opts) => bot.sendVideo(chatId, video, opts),
    sendAudio: (chatId, audio, opts) => bot.sendAudio(chatId, audio, opts),
    sendVoice: (chatId, voice, opts) => bot.sendVoice(chatId, voice, opts),
    sendAnimation: (chatId, anim, opts) => bot.sendAnimation(chatId, anim, opts),
    sendVideoNote: (chatId, note, opts) => bot.sendVideoNote(chatId, note, opts),
    sendMediaGroup: (chatId, media, opts) => bot.sendMediaGroup(chatId, media, opts),
    downloadMessageMedia,
    getCustomEmojiInfo: ids => bot.getCustomEmojiInfo(ids),
    bot,
    userbot,
  };
};
