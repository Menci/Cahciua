import type { Logger } from '@guiiai/logg';
import { Api, TelegramClient } from 'telegram';
import { NewMessage, type NewMessageEvent } from 'telegram/events';
import { DeletedMessage, type DeletedMessageEvent } from 'telegram/events/DeletedMessage';
import { EditedMessage, type EditedMessageEvent } from 'telegram/events/EditedMessage';
import { StringSession } from 'telegram/sessions';

import { createEventBus } from './event-bus';
import { patchGramjsLogger } from './gramjs-logger';
import type { TelegramMessage, TelegramMessageDelete, TelegramMessageEdit } from './message';
import { fromGramjsAnyMessage, fromGramjsDeletedMessage, fromGramjsEditedMessage, resolveGramjsSender } from './message';

export interface UserbotOptions {
  apiId: number;
  apiHash: string;
  session: string;
}

export interface UserbotClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage: (handler: (msg: TelegramMessage) => void) => void;
  onMessageEdit: (handler: (edit: TelegramMessageEdit) => void) => void;
  onMessageDelete: (handler: (del: TelegramMessageDelete) => void) => void;
  fetchMessages(chatId: string, options: FetchOptions): Promise<TelegramMessage[]>;
  fetchSpecificMessages(chatId: string, messageIds: number[]): Promise<TelegramMessage[]>;
  downloadMessageMedia(chatId: string, messageId: number): Promise<Buffer | undefined>;
  raw(): TelegramClient;
  getSessionString(): string;
}

export interface FetchOptions {
  limit?: number;
  minId?: number;
  maxId?: number;
  offsetId?: number;
}

export const createUserbotClient = (options: UserbotOptions, logger: Logger): UserbotClient => {
  const log = logger.withContext('telegram:userbot');
  const session = new StringSession(options.session);
  const client = new TelegramClient(session, options.apiId, options.apiHash, {
    connectionRetries: 3,
  });

  patchGramjsLogger(client, log);

  const messageBus = createEventBus<TelegramMessage>('userbot:message', log);
  const editBus = createEventBus<TelegramMessageEdit>('userbot:edit', log);
  const deleteBus = createEventBus<TelegramMessageDelete>('userbot:delete', log);
  let eventHandlerRegistered = false;

  const registerEventHandler = () => {
    if (eventHandlerRegistered) return;
    eventHandlerRegistered = true;

    client.addEventHandler(
      (event: NewMessageEvent) => {
        if (!event.message || event.message instanceof Api.MessageEmpty) return;
        const msg = fromGramjsAnyMessage(event.message);
        if (msg) messageBus.emit(msg);
      },
      new NewMessage({}),
    );

    client.addEventHandler(
      (event: EditedMessageEvent) => {
        if (!event.message || event.message instanceof Api.MessageEmpty) return;
        // MTProto fires updateEditMessage for metadata-only changes (link preview
        // loading, first reaction in large supergroups, inline keyboard updates,
        // edit_hide corrections). These "phantom edits" have no editDate.
        // Skip them here — if we later need reactions, subscribe to
        // updateMessageReactions separately instead of relying on edit events.
        if (!event.message.editDate) return;
        const msg = event.message;
        const sender = resolveGramjsSender(msg);
        editBus.emit(fromGramjsEditedMessage(msg, sender));
      },
      new EditedMessage({}),
    );

    client.addEventHandler(
      (event: DeletedMessageEvent) => {
        const peer = event.peer instanceof Api.PeerChannel ? event.peer : undefined;
        deleteBus.emit(fromGramjsDeletedMessage(event.deletedIds, peer));
      },
      new DeletedMessage({}),
    );

    log.log('Event handlers registered');
  };

  const start = async () => {
    log.log('Connecting...');
    await client.connect();

    const authorized = await client.isUserAuthorized();
    if (!authorized) {
      throw new Error(
        'Userbot session is not authorized. Run `pnpm login` to create a session first.',
      );
    }

    const me = await client.getMe();
    if (me instanceof Api.User) {
      log.withFields({
        id: me.id.toJSNumber(),
        username: me.username,
        name: [me.firstName, me.lastName].filter(Boolean).join(' '),
      }).log('Authenticated');
    }

    registerEventHandler();
  };

  const stop = async () => {
    log.log('Disconnecting...');
    await client.disconnect();
    log.log('Disconnected');
  };

  const fetchMessages = async (chatId: string, opts: FetchOptions): Promise<TelegramMessage[]> => {
    const messages = await client.getMessages(chatId, {
      limit: opts.limit ?? 100,
      minId: opts.minId,
      maxId: opts.maxId,
      offsetId: opts.offsetId,
    });

    return messages
      .filter(m => !(m instanceof Api.MessageEmpty))
      .flatMap(m => {
        const result = fromGramjsAnyMessage(m);
        return result ? [result] : [];
      });
  };

  const fetchSpecificMessages = async (chatId: string, messageIds: number[]): Promise<TelegramMessage[]> => {
    if (messageIds.length === 0) return [];

    const messages = await client.getMessages(chatId, { ids: messageIds });

    return messages
      .filter(m => !(m instanceof Api.MessageEmpty))
      .flatMap(m => {
        const result = fromGramjsAnyMessage(m);
        return result ? [result] : [];
      });
  };

  const downloadMessageMedia = async (chatId: string, messageId: number): Promise<Buffer | undefined> => {
    const msgs = await client.getMessages(chatId, { ids: [messageId] });
    const msg = msgs[0];
    if (!msg || msg instanceof Api.MessageEmpty || !msg.media) return undefined;
    const result = await client.downloadMedia(msg, {});
    return Buffer.isBuffer(result) ? result : undefined;
  };

  return {
    start,
    stop,
    onMessage: messageBus.on,
    onMessageEdit: editBus.on,
    onMessageDelete: deleteBus.on,
    fetchMessages,
    fetchSpecificMessages,
    downloadMessageMedia,
    raw: () => client,
    getSessionString: () => String(client.session.save()),
  };
};
