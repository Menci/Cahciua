import type { Logger } from '@guiiai/logg';
import * as tdl from 'tdl';
import type * as Td from 'tdlib-types';

import type { EntityCache } from './entity-cache';
import { createEntityCache } from './entity-cache';
import { createEventBus } from './event-bus';
import type { TelegramMessage, TelegramMessageDelete, TelegramMessageEdit } from './message';
import { serverToTdLibMessageId, tdLibToServerMessageId } from './message/id-conversion';
import { resolveMessageMetadata } from './message/resolve-metadata';
import { fromTdMessage, fromTdMessageEdited } from './message/tdlib';
import { isTypingLikeAction } from './typing-action';

export interface UserbotOptions {
  apiId: number;
  apiHash: string;
  databaseDirectory: string;
  filesDirectory: string;
}

export interface TypingEvent {
  chatId: string;
  userId: string;
}

export interface UserbotClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage: (handler: (msg: TelegramMessage) => void) => void;
  onMessageEdit: (handler: (edit: TelegramMessageEdit) => void) => void;
  onMessageDelete: (handler: (del: TelegramMessageDelete) => void) => void;
  onTyping: (handler: (event: TypingEvent) => void) => void;
  fetchMessages(chatId: string, options: FetchOptions): Promise<TelegramMessage[]>;
  fetchSpecificMessages(chatId: string, messageIds: number[]): Promise<TelegramMessage[]>;
  downloadMessageMedia(chatId: string, messageId: number): Promise<Buffer | undefined>;
  openChat(chatId: string): Promise<void>;
  closeChat(chatId: string): Promise<void>;
  raw(): tdl.Client;
  entityCache(): EntityCache;
}

export interface FetchOptions {
  limit?: number;
  minId?: number;
  maxId?: number;
  offsetId?: number;
}

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

export const createUserbotClient = (options: UserbotOptions, logger: Logger): UserbotClient => {
  const log = logger.withContext('telegram:userbot');
  const cache = createEntityCache();

  const client = tdl.createClient({
    apiId: options.apiId,
    apiHash: options.apiHash,
    databaseDirectory: options.databaseDirectory,
    filesDirectory: options.filesDirectory,
    tdlibParameters: {
      device_model: 'Cahciua userbot',
      application_version: '1.0',
      use_message_database: true,
      use_chat_info_database: true,
      use_secret_chats: false,
    },
  });

  client.on('error', err => { log.withError(err).error('tdl client error'); });

  const messageBus = createEventBus<TelegramMessage>('userbot:message', log);
  const editBus = createEventBus<TelegramMessageEdit>('userbot:edit', log);
  const deleteBus = createEventBus<TelegramMessageDelete>('userbot:delete', log);
  const typingBus = createEventBus<TypingEvent>('userbot:typing', log);

  client.on('update', (update: Td.Update) => {
    switch (update._) {
    case 'updateUser':
      cache.putUser(update.user);
      return;
    case 'updateNewChat':
      cache.putChat(update.chat);
      return;
    case 'updateNewMessage': {
      const msg = fromTdMessage(cache, update.message);
      if (msg) {
        void (async () => {
          await resolveMessageMetadata(client, msg);
          messageBus.emit(msg);
        })();
      }
      return;
    }
    case 'updateMessageEdited': {
      // Edit fires updateMessageEdited (with new edit_date) AND updateMessageContent.
      // We re-fetch the message to get the full updated state and emit a single edit.
      // Phantom edits (link preview load, etc.) do not fire updateMessageEdited — only
      // updateMessageContent — so this gating is exactly what we want.
      void (async () => {
        try {
          const msg = await client.invoke({ _: 'getMessage', chat_id: update.chat_id, message_id: update.message_id }) as Td.message;
          const edit = fromTdMessageEdited(cache, msg);
          if (edit) {
            await resolveMessageMetadata(client, edit);
            editBus.emit(edit);
          }
        } catch (err) {
          log.withError(err).withFields({ chatId: update.chat_id, messageId: update.message_id }).warn('Failed to fetch edited message');
        }
      })();
      return;
    }
    case 'updateDeleteMessages': {
      if (!update.is_permanent) return;
      deleteBus.emit({ messageIds: [...update.message_ids].map(tdLibToServerMessageId), chatId: String(update.chat_id) });
      return;
    }
    case 'updateChatAction': {
      if (update.sender_id._ !== 'messageSenderUser') return;
      if (!isTypingLikeAction(update.action)) return;
      typingBus.emit({ chatId: String(update.chat_id), userId: String(update.sender_id.user_id) });
      return;
    }
    }
  });

  const start = async () => {
    log.log('Connecting...');
    await client.login(); // Interactive prompt: phone → code → 2FA. Use `pnpm login` to do this once.
    const me = await client.invoke({ _: 'getMe' }) as Td.user;
    log.withFields({
      id: me.id,
      username: me.usernames?.editable_username || me.usernames?.active_usernames?.[0],
      name: [me.first_name, me.last_name].filter(Boolean).join(' '),
    }).log('Authenticated');
    // Warm chat cache so updates can resolve sender info before we see them.
    try {
      await client.invoke({ _: 'loadChats', chat_list: { _: 'chatListMain' }, limit: 500 });
    } catch (err) {
      log.withError(err).debug('loadChats returned (often expected: no more chats)');
    }
  };

  const stop = async () => {
    log.log('Disconnecting...');
    await client.close();
    log.log('Disconnected');
  };

  const fetchMessages = async (chatId: string, opts: FetchOptions): Promise<TelegramMessage[]> => {
    const limit = opts.limit ?? 100;
    const result = await client.invoke({
      _: 'getChatHistory',
      chat_id: Number(chatId),
      from_message_id: opts.offsetId ? serverToTdLibMessageId(opts.offsetId) : 0,
      offset: 0,
      limit,
      only_local: false,
    }) as Td.messages;
    const msgs = result.messages.flatMap((m): TelegramMessage[] => {
      if (!m) return [];
      const conv = fromTdMessage(cache, m);
      if (!conv) return [];
      if (opts.minId !== undefined && conv.messageId <= opts.minId) return [];
      if (opts.maxId !== undefined && conv.messageId >= opts.maxId) return [];
      return [conv];
    });
    await Promise.all(msgs.map(m => resolveMessageMetadata(client, m)));
    return msgs;
  };

  const fetchSpecificMessages = async (chatId: string, messageIds: number[]): Promise<TelegramMessage[]> => {
    if (messageIds.length === 0) return [];
    const result = await client.invoke({
      _: 'getMessages',
      chat_id: Number(chatId),
      message_ids: messageIds.map(serverToTdLibMessageId),
    }) as Td.messages;
    const msgs = result.messages.flatMap((m): TelegramMessage[] => {
      if (!m) return [];
      const conv = fromTdMessage(cache, m);
      return conv ? [conv] : [];
    });
    await Promise.all(msgs.map(m => resolveMessageMetadata(client, m)));
    return msgs;
  };

  const waitForFileDownload = async (fileId: number, timeoutMs = 60000): Promise<Td.file> => {
    const result = await Promise.race([
      client.invoke({ _: 'downloadFile', file_id: fileId, priority: 1, offset: 0, limit: 0, synchronous: true }) as Promise<Td.file>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Download timeout')), timeoutMs)),
    ]);
    if (!result.local.is_downloading_completed)
      throw new Error(`File ${fileId} did not finish downloading`);
    return result;
  };

  const downloadMessageMedia = async (chatId: string, messageId: number): Promise<Buffer | undefined> => {
    const msg = await client.invoke({ _: 'getMessage', chat_id: Number(chatId), message_id: serverToTdLibMessageId(messageId) }) as Td.message;
    const file = findFileInContent(msg.content);
    if (!file) return undefined;
    const downloaded = await waitForFileDownload(file.id);
    const fs = await import('node:fs/promises');
    return await fs.readFile(downloaded.local.path);
  };

  const openChat = async (chatId: string) => {
    await client.invoke({ _: 'openChat', chat_id: Number(chatId) });
  };

  const closeChat = async (chatId: string) => {
    await client.invoke({ _: 'closeChat', chat_id: Number(chatId) });
  };

  return {
    start,
    stop,
    onMessage: messageBus.on,
    onMessageEdit: editBus.on,
    onMessageDelete: deleteBus.on,
    onTyping: typingBus.on,
    fetchMessages,
    fetchSpecificMessages,
    downloadMessageMedia,
    openChat,
    closeChat,
    raw: () => client,
    entityCache: () => cache,
  };
};
