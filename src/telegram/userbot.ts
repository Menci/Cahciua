import type { Logger } from '@guiiai/logg';
import { Api, TelegramClient } from 'teleproto';
import { DeletedMessage, EditedMessage, NewMessage, Raw } from 'teleproto/events';
import type { DeletedMessageEvent } from 'teleproto/events';
import type { StringSession } from 'teleproto/sessions';

import { createEventBus } from './event-bus';
import { captureIngressMetadata } from './ingress-meta';
import type { TelegramMessage, TelegramMessageDelete, TelegramMessageEdit } from './message';
import { resolveMessageMetadata } from './message/resolve-metadata';
import { fromTeleprotoDelete, fromTeleprotoEdit, fromTeleprotoMessage } from './message/teleproto';
import { createTeleprotoLogger } from './teleproto-logger';
import { isTypingLikeAction } from './typing-action';

export interface UserbotOptions {
  apiId: number;
  apiHash: string;
  session: StringSession;
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
  raw(): TelegramClient;
}

export interface FetchOptions {
  limit?: number;
  offsetId?: number;
}

export const createUserbotClient = (options: UserbotOptions, logger: Logger): UserbotClient => {
  const log = logger.withContext('telegram:userbot');
  const client = new TelegramClient(options.session, options.apiId, options.apiHash, {
    connectionRetries: 3,
    catchUp: false,
    baseLogger: createTeleprotoLogger(log),
  });
  const messageBus = createEventBus<TelegramMessage>('userbot:message', log);
  const editBus = createEventBus<TelegramMessageEdit>('userbot:edit', log);
  const deleteBus = createEventBus<TelegramMessageDelete>('userbot:delete', log);
  const typingBus = createEventBus<TypingEvent>('userbot:typing', log);
  const updateQueues = new Map<string, Promise<void>>();

  const enqueueUpdate = (chatId: string, task: () => Promise<void>): void => {
    const previous = updateQueues.get(chatId) ?? Promise.resolve();
    const current = previous.then(task);
    updateQueues.set(chatId, current);
    void current.then(
      () => {
        if (updateQueues.get(chatId) === current) updateQueues.delete(chatId);
      },
      error => log.withError(error).withFields({ chatId }).error('Userbot update queue blocked'),
    );
  };

  const registerHandlers = () => {
    client.addEventHandler(event => {
      if (!event.message) return;
      const message = fromTeleprotoMessage(event.message, 'userbot');
      if (message) {
        const ingress = captureIngressMetadata(message);
        enqueueUpdate(ingress.chatId, async () => messageBus.emit(ingress));
      }
    }, new NewMessage({}));

    client.addEventHandler(event => {
      if (!event.message) return;
      const edit = fromTeleprotoEdit(event.message);
      if (!edit) return;
      const ingress = captureIngressMetadata(edit);
      enqueueUpdate(ingress.chatId, async () => editBus.emit(ingress));
    }, new EditedMessage({}));

    client.addEventHandler((event: DeletedMessageEvent) => {
      const update = event.originalUpdate;
      if (!(update instanceof Api.UpdateDeleteChannelMessages)) return;
      const deletion = captureIngressMetadata(fromTeleprotoDelete(`-100${update.channelId}`, event.deletedIds));
      enqueueUpdate(deletion.chatId!, async () => deleteBus.emit(deletion as IngressDelete));
    }, new DeletedMessage({}));

    client.addEventHandler((update: Api.TypeUpdate) => {
      if (update instanceof Api.UpdateChannelUserTyping) {
        const chatId = `-100${update.channelId}`;
        if (update.fromId instanceof Api.PeerUser && isTypingLikeAction(update.action))
          typingBus.emit({ chatId, userId: String(update.fromId.userId) });
      } else if (update instanceof Api.UpdateChatUserTyping) {
        const chatId = `-${update.chatId}`;
        if (update.fromId instanceof Api.PeerUser && isTypingLikeAction(update.action))
          typingBus.emit({ chatId, userId: String(update.fromId.userId) });
      }
    }, new Raw({ types: [Api.UpdateChannelUserTyping, Api.UpdateChatUserTyping] }));
  };

  type IngressDelete = TelegramMessageDelete & { chatId: string };

  const start = async () => {
    log.log('Connecting...');
    await client.connect();
    if (!(await client.isUserAuthorized()))
      throw new Error('Userbot session is not authorized. Run `pnpm login` first.');
    const me = await client.getMe();
    log.withFields({ id: String(me.id), username: me.username }).log('Authenticated');
    registerHandlers();
    await client.getDialogs({ limit: 500 });
  };

  const stop = async () => {
    log.log('Disconnecting...');
    await client.destroy();
    log.log('Disconnected');
  };

  const toMessages = (messages: Api.Message[]): TelegramMessage[] =>
    messages.flatMap(message => {
      const converted = fromTeleprotoMessage(message, 'userbot');
      return converted ? [converted] : [];
    });

  const fetchMessages = async (chatId: string, opts: FetchOptions): Promise<TelegramMessage[]> => {
    const messages = await client.getMessages(chatId, {
      limit: opts.limit ?? 100,
      offsetId: opts.offsetId,
    });
    const converted = toMessages([...messages]);
    await Promise.all(converted.map(message => resolveMessageMetadata(client, message)));
    return converted;
  };

  const fetchSpecificMessages = async (chatId: string, messageIds: number[]): Promise<TelegramMessage[]> => {
    if (messageIds.length === 0) return [];
    const messages = await client.getMessages(chatId, { ids: messageIds });
    const converted = toMessages([...messages]);
    await Promise.all(converted.map(message => resolveMessageMetadata(client, message)));
    return converted;
  };

  const downloadMessageMedia = async (chatId: string, messageId: number): Promise<Buffer | undefined> => {
    const messages = await client.getMessages(chatId, { ids: [messageId] });
    const message = messages[0];
    if (!message?.media) return undefined;
    const result = await client.downloadMedia(message, {});
    return Buffer.isBuffer(result) ? result : undefined;
  };

  const openChat = async (chatId: string) => {
    await client.getInputEntity(chatId);
  };

  const closeChat = async () => {};

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
  };
};
