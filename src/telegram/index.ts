import type { Logger } from '@guiiai/logg';

import type { BotClient, SendOptions, SentMessage } from './bot';
import { createBotClient } from './bot';
import { createEventBus } from './event-bus';
import type { ImageToTextResolver } from './image-to-text';
import { createMessageDedup, mergeTelegramMessageData } from './message';
import type { TelegramMessage, TelegramMessageDelete, TelegramMessageEdit, Attachment } from './message';
import { createSessionIngressQueue } from './session-ingress-queue';
import { canGenerateThumbnail, generateThumbnail } from './thumbnail';
import type { FetchOptions, UserbotClient } from './userbot';
import { createUserbotClient } from './userbot';

export interface TelegramManagerOptions {
  botToken: string;
  apiId: number;
  apiHash: string;
  session: string;
  initialChatIds?: string[];
  // Resolve chatId for delete events that lack it (MTProto private chat/basic group deletes).
  // The message IDs in this space are globally unique, so a lookup by messageId suffices.
  resolveChatId?: (messageIds: number[]) => string | undefined;
  imageToText?: ImageToTextResolver;
  imageToTextChatIds?: Set<string>;
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
  sendMessage(chatId: string | number, text: string, options?: SendOptions): Promise<SentMessage>;
  fetchMessages(chatId: string, options: FetchOptions): Promise<TelegramMessage[]>;
  fetchSpecificMessages(chatId: string, messageIds: number[]): Promise<TelegramMessage[]>;
  botUserId: string;
  bot: BotClient;
  userbot: UserbotClient;
}

export const createTelegramManager = (
  options: TelegramManagerOptions,
  logger: Logger,
): TelegramManager => {
  const log = logger.withContext('telegram:manager');
  const bot = createBotClient({ token: options.botToken }, logger);
  const userbot = createUserbotClient({
    apiId: options.apiId,
    apiHash: options.apiHash,
    session: options.session,
  }, logger);

  const dedup = createMessageDedup();
  const botChats = new Set<string>(options.initialChatIds);
  const inflight = new Map<string, TelegramMessage>();
  const messageBus = createEventBus<TelegramMessage>('telegram:message', logger);
  const editBus = createEventBus<TelegramMessageEdit>('telegram:edit', logger);
  const deleteBus = createEventBus<TelegramMessageDelete>('telegram:delete', logger);

  // Unified download: fileId → Bot API, else → userbot by chatId+messageId
  const downloadAttachmentMedia = async (
    chatId: string,
    messageId: number,
    att: Attachment,
  ): Promise<Buffer | undefined> => {
    if (att.fileId) {
      return await bot.downloadFile(att.fileId);
    }
    return await userbot.downloadMessageMedia(chatId, messageId);
  };

  const imageToText = options.imageToText;
  const imageToTextChatIds = options.imageToTextChatIds;

  const hydrateAttachments = async (
    chatId: string,
    messageId: number,
    text: string,
    attachments?: Attachment[],
  ) => {
    if (!attachments) return;

    // Phase 1: Download media + generate thumbnails for eligible attachments.
    // Keep original buffers for high-res LLM input later.
    const originalBuffers = new Map<Attachment, Buffer>();
    await Promise.all(attachments.map(async att => {
      if (att.thumbnailWebp || !canGenerateThumbnail(att)) return;
      try {
        const buffer = await downloadAttachmentMedia(chatId, messageId, att);
        if (buffer) {
          originalBuffers.set(att, buffer);
          att.thumbnailWebp = await generateThumbnail(buffer);
        }
      } catch (err) {
        log.withError(err).warn('Failed to generate thumbnail');
      }
    }));

    // Phase 2: Call image-to-text resolver for each attachment with a thumbnail.
    // Alt text is NOT set on the Attachment — it goes into the image_alt_texts table
    // and is hydrated transiently on CanonicalAttachment at query time.
    // Only resolve for whitelisted chats to avoid wasting LLM calls.
    if (imageToText && (!imageToTextChatIds || imageToTextChatIds.has(chatId))) {
      await Promise.all(attachments.map(async att => {
        if (!att.thumbnailWebp) return;
        const thumbnailBuffer = Buffer.from(att.thumbnailWebp, 'base64');
        const highResBuffer = originalBuffers.get(att);
        await imageToText.resolve(thumbnailBuffer, text, highResBuffer);
      }));
    }
  };

  const ingressQueue = createSessionIngressQueue<IngressEvent>({
    logger,
    transform: async event => {
      switch (event.kind) {
      case 'message':
        await hydrateAttachments(event.chatId, event.message.messageId, event.message.text, event.message.attachments);
        return event;
      case 'edit':
        await hydrateAttachments(event.chatId, event.edit.messageId, event.edit.text, event.edit.attachments);
        return event;
      case 'delete':
        return event;
      }
    },
    commit: event => {
      switch (event.kind) {
      case 'message':
        inflight.delete(`${event.chatId}:${event.message.messageId}`);
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

  const dispatchMessage = (msg: TelegramMessage) => {
    const key = `${msg.chatId}:${msg.messageId}`;

    if (!dedup.tryAdd(msg.chatId, msg.messageId)) {
      // Second arrival — if bot version, merge richer Bot API metadata into
      // the in-flight userbot message while preserving any userbot-only fields.
      if (msg.source === 'bot') {
        const existing = inflight.get(key);
        if (existing) mergeTelegramMessageData(existing, msg);
      }
      return;
    }

    const enriched = { ...msg, ...captureIngressMeta() };
    inflight.set(key, enriched);
    ingressQueue.enqueue({ kind: 'message', chatId: enriched.chatId, message: enriched });
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
    botUserId: bot.botUserId(),
    bot,
    userbot,
  };
};
