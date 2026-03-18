import type { Logger } from '@guiiai/logg';

import type { BotClient, SendOptions, SentMessage } from './bot';
import { createBotClient } from './bot';
import { createEventBus } from './event-bus';
import { createMessageDedup, mergeTelegramMessageData } from './message';
import type { TelegramMessage, TelegramMessageDelete, TelegramMessageEdit, Attachment } from './message';
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
}

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

  // Generate thumbnails for all eligible attachments on a message or edit
  const hydrateThumbnails = async (
    chatId: string,
    messageId: number,
    attachments?: Attachment[],
  ) => {
    if (!attachments) return;
    for (const att of attachments) {
      if (!canGenerateThumbnail(att)) continue;
      try {
        const buffer = await downloadAttachmentMedia(chatId, messageId, att);
        if (buffer) att.thumbnailWebp = await generateThumbnail(buffer);
      } catch (err) {
        log.withError(err).warn('Failed to generate thumbnail');
      }
    }
  };

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

    inflight.set(key, msg);
    void hydrateThumbnails(msg.chatId, msg.messageId, msg.attachments)
      .catch(err => log.withError(err).warn('Thumbnail hydration failed'))
      .finally(() => {
        inflight.delete(key);
        messageBus.emit(msg);
      });
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
    void hydrateThumbnails(edit.chatId, edit.messageId, edit.attachments)
      .catch(err => log.withError(err).warn('Thumbnail hydration failed'))
      .finally(() => editBus.emit(edit));
  });

  userbot.onMessageDelete(del => {
    const chatId = del.chatId ?? options.resolveChatId?.(del.messageIds);
    if (!chatId || !botChats.has(chatId)) return;
    deleteBus.emit({ ...del, chatId });
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
