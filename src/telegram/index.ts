import { mkdirSync } from 'node:fs';

import type { Logger } from '@guiiai/logg';

import type { AnimationToTextResolver } from './animation-to-text';
import type { BotClient, CustomEmojiInfo, MediaGroupItem, MediaSendOptions, SendOptions, SentMessage } from './bot';
import { createBotClient } from './bot';
import type { CustomEmojiToTextResolver } from './custom-emoji-to-text';
import { createEventBus } from './event-bus';
import { canExtractFrames, extractFrames } from './frame-extractor';
import type { ImageToTextResolver } from './image-to-text';
import type { Attachment, MessageEntity, TelegramMessage, TelegramMessageDelete, TelegramMessageEdit } from './message';
import { normalizeStickerSetMetadata } from './pack-title';
import { createSessionIngressQueue } from './session-ingress-queue';
import { canGenerateThumbnail, generateThumbnail } from './thumbnail';
import type { FetchOptions, TypingEvent, UserbotClient } from './userbot';
import { createUserbotClient } from './userbot';

export interface TelegramManagerOptions {
  apiId: number;
  apiHash: string;
  botToken: string;
  /** Whether to enable userbot (requires interactive login via `pnpm login`). */
  userbotEnabled: boolean;
  /** Per-client tdlib state directories (database + files). */
  botDataDir: string;
  userbotDataDir: string;
  initialChatIds?: string[];
  resolveChatId?: (messageIds: number[]) => string | undefined;
  imageToText?: ImageToTextResolver;
  imageToTextChatIds?: Set<string>;
  animationToText?: AnimationToTextResolver;
  animationToTextChatIds?: Set<string>;
  animationMaxFrames?: number;
  customEmojiToText?: CustomEmojiToTextResolver;
  customEmojiToTextChatIds?: Set<string>;
}

type IngressEvent =
  | { kind: 'message'; chatId: string; message: TelegramMessage }
  | { kind: 'edit'; chatId: string; edit: TelegramMessageEdit }
  | { kind: 'delete'; chatId: string; del: TelegramMessageDelete };

const captureIngressMeta = () => ({
  receivedAtMs: Date.now(),
  utcOffsetMin: -new Date().getTimezoneOffset(),
});

export interface TelegramManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage: (handler: (msg: TelegramMessage) => void) => void;
  onMessageEdit: (handler: (edit: TelegramMessageEdit) => void) => void;
  onMessageDelete: (handler: (del: TelegramMessageDelete) => void) => void;
  onTyping: (handler: (typing: TypingEvent) => void) => void;
  startTypingPolling(chatId: string): void;
  stopTypingPolling(chatId: string): void;
  sendChatAction(chatId: string | number): Promise<void>;
  sendMessage(chatId: string | number, text: string, options?: SendOptions): Promise<SentMessage>;
  sendPhoto(chatId: string | number, photo: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendDocument(chatId: string | number, document: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendVideo(chatId: string | number, video: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendAudio(chatId: string | number, audio: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendVoice(chatId: string | number, voice: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendAnimation(chatId: string | number, animation: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendVideoNote(chatId: string | number, videoNote: Buffer, options?: MediaSendOptions): Promise<SentMessage>;
  sendMediaGroup(chatId: string | number, media: MediaGroupItem[], options?: SendOptions): Promise<SentMessage[]>;
  fetchMessages(chatId: string, options: FetchOptions): Promise<TelegramMessage[]>;
  fetchSpecificMessages(chatId: string, messageIds: number[]): Promise<TelegramMessage[]>;
  downloadMessageMedia(chatId: string, messageId: number): Promise<Buffer | undefined>;
  getCustomEmojiInfo(customEmojiIds: string[]): Promise<CustomEmojiInfo[]>;
  resolvePackTitle(setIdOrName: string): Promise<string>;
  botUserId: string;
  bot: BotClient;
  userbot?: UserbotClient;
}

export const createTelegramManager = (
  options: TelegramManagerOptions,
  logger: Logger,
): TelegramManager => {
  const log = logger.withContext('telegram:manager');

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

  // Single-source ingress: prefer userbot when present (full visibility), fall
  // back to bot client otherwise (limited by Telegram's bot privacy rules).
  const ingressFromUserbot = userbot != null;

  const botChats = new Set<string>(options.initialChatIds);
  const messageBus = createEventBus<TelegramMessage>('telegram:message', logger);
  const editBus = createEventBus<TelegramMessageEdit>('telegram:edit', logger);
  const deleteBus = createEventBus<TelegramMessageDelete>('telegram:delete', logger);
  const typingBus = createEventBus<TypingEvent>('telegram:typing', logger);

  const downloadMessageMedia = async (chatId: string, messageId: number): Promise<Buffer | undefined> => {
    if (userbot) {
      const buf = await userbot.downloadMessageMedia(chatId, messageId);
      if (buf) return buf;
    }
    return await bot.downloadMessageMedia(chatId, messageId);
  };

  const imageToText = options.imageToText;
  const imageToTextChatIds = options.imageToTextChatIds;
  const animationToText = options.animationToText;
  const animationToTextChatIds = options.animationToTextChatIds;
  const animationMaxFrames = options.animationMaxFrames;
  const customEmojiToText = options.customEmojiToText;
  const customEmojiToTextChatIds = options.customEmojiToTextChatIds;

  const packTitleCache = new Map<string, string>();
  const packTitleInflight = new Map<string, Promise<string>>();
  const resolvePackTitle = async (setIdOrName: string): Promise<string> => {
    const cached = packTitleCache.get(setIdOrName);
    if (cached) return cached;
    const inflight = packTitleInflight.get(setIdOrName);
    if (inflight) return await inflight;

    const task = (async () => {
      try {
        const title = await bot.getStickerSetTitle(setIdOrName);
        packTitleCache.set(setIdOrName, title);
        return title;
      } catch (err) {
        log.withError(err).withFields({ setIdOrName }).warn('Failed to resolve pack title');
        return setIdOrName;
      } finally {
        packTitleInflight.delete(setIdOrName);
      }
    })();

    packTitleInflight.set(setIdOrName, task);
    return await task;
  };

  const hydrateAttachments = async (
    chatId: string,
    messageId: number,
    text: string,
    attachments?: Attachment[],
    entities?: MessageEntity[],
  ) => {
    if (attachments) {
      await normalizeStickerSetMetadata(attachments, resolvePackTitle);

      const originalBuffers = new Map<Attachment, Buffer>();
      await Promise.all(attachments.map(async att => {
        if (att.thumbnailWebp || !canGenerateThumbnail(att)) return;
        try {
          const buffer = await downloadMessageMedia(chatId, messageId);
          if (buffer) {
            originalBuffers.set(att, buffer);
            att.thumbnailWebp = await generateThumbnail(buffer);
          }
        } catch (err) {
          log.withError(err).warn('Failed to generate thumbnail');
        }
      }));

      if (imageToText && (!imageToTextChatIds || imageToTextChatIds.has(chatId))) {
        await Promise.all(attachments.map(async att => {
          if (!att.thumbnailWebp) return;
          const thumbnailBuffer = Buffer.from(att.thumbnailWebp, 'base64');
          const highResBuffer = originalBuffers.get(att);
          await imageToText.resolve(thumbnailBuffer, text, highResBuffer);
        }));
      }

      if (animationToText && (!animationToTextChatIds || animationToTextChatIds.has(chatId))) {
        await Promise.all(attachments.map(async att => {
          if (!canExtractFrames(att)) return;
          try {
            const buffer = await downloadMessageMedia(chatId, messageId);
            if (!buffer) return;
            const { frames, cacheKey, frameTimestamps } = await extractFrames(buffer, att, animationMaxFrames);
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
          } catch (err) {
            log.withError(err).warn('Failed to process animation-to-text');
          }
        }));
      }
    }

    if (customEmojiToText && (!customEmojiToTextChatIds || customEmojiToTextChatIds.has(chatId)) && entities) {
      const emojiIds = new Map<string, string>();
      for (const ent of entities) {
        if (ent.type === 'custom_emoji' && ent.customEmojiId) {
          const fallback = text.substring(ent.offset, ent.offset + ent.length);
          emojiIds.set(ent.customEmojiId, fallback);
        }
      }
      if (emojiIds.size > 0) {
        await customEmojiToText.resolve(emojiIds);
      }
    }
  };

  const ingressQueue = createSessionIngressQueue<IngressEvent>({
    logger,
    transform: async event => {
      switch (event.kind) {
      case 'message':
        await hydrateAttachments(event.chatId, event.message.messageId, event.message.text, event.message.attachments, event.message.entities);
        return event;
      case 'edit':
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
    const enriched = { ...msg, ...captureIngressMeta() };
    ingressQueue.enqueue({ kind: 'message', chatId: enriched.chatId, message: enriched });
  };

  const handleTypingEvent = (typing: TypingEvent) => {
    if (!botChats.has(typing.chatId)) return;
    logger.withFields({ chatId: typing.chatId, userId: typing.userId }).debug('Telegram typing event received');
    typingBus.emit(typing);
  };

  if (ingressFromUserbot && userbot) {
    userbot.onMessage(ingestMessage);

    userbot.onMessageEdit(edit => {
      if (!botChats.has(edit.chatId)) return;
      ingressQueue.enqueue({
        kind: 'edit',
        chatId: edit.chatId,
        edit: { ...edit, ...captureIngressMeta() },
      });
    });

    userbot.onMessageDelete(del => {
      const chatId = del.chatId ?? options.resolveChatId?.(del.messageIds);
      if (!chatId || !botChats.has(chatId)) return;
      ingressQueue.enqueue({
        kind: 'delete',
        chatId,
        del: { ...del, chatId, ...captureIngressMeta() },
      });
    });

    userbot.onTyping(handleTypingEvent);
  } else {
    bot.onMessage(ingestMessage);
  }

  // Active typing observation: openChat tells tdlib we're "viewing" a chat,
  // which makes it deliver updateChatAction for that chat reliably even in
  // large supergroups. closeChat reverses it. Replaces the gramjs typing-poll.
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
    sendPhoto: (chatId, photo, opts) => bot.sendPhoto(chatId, photo, opts),
    sendDocument: (chatId, doc, opts) => bot.sendDocument(chatId, doc, opts),
    sendVideo: (chatId, video, opts) => bot.sendVideo(chatId, video, opts),
    sendAudio: (chatId, audio, opts) => bot.sendAudio(chatId, audio, opts),
    sendVoice: (chatId, voice, opts) => bot.sendVoice(chatId, voice, opts),
    sendAnimation: (chatId, anim, opts) => bot.sendAnimation(chatId, anim, opts),
    sendVideoNote: (chatId, note, opts) => bot.sendVideoNote(chatId, note, opts),
    sendMediaGroup: (chatId, media, opts) => bot.sendMediaGroup(chatId, media, opts),
    fetchMessages: (chatId, opts) => userbot?.fetchMessages(chatId, opts) ?? Promise.resolve([]),
    fetchSpecificMessages: (chatId, ids) => userbot?.fetchSpecificMessages(chatId, ids) ?? Promise.resolve([]),
    downloadMessageMedia,
    getCustomEmojiInfo: ids => bot.getCustomEmojiInfo(ids),
    resolvePackTitle,
    botUserId: bot.botUserId(),
    bot,
    userbot,
  };
};
