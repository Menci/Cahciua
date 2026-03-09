import type { Logger } from '@guiiai/logg';
import { Api, TelegramClient } from 'telegram';
import { NewMessage, type NewMessageEvent } from 'telegram/events';
import { DeletedMessage, type DeletedMessageEvent } from 'telegram/events/DeletedMessage';
import { EditedMessage, type EditedMessageEvent } from 'telegram/events/EditedMessage';
import { StringSession } from 'telegram/sessions';

import { patchGramjsLogger } from './gramjs-logger';
import type { TelegramMessage, TelegramMessageDelete, TelegramMessageEdit } from './message';
import { fromGramjsDeletedMessage, fromGramjsEditedMessage, fromGramjsMessage, resolveGramjsSender } from './message';

export interface UserbotOptions {
  apiId: number;
  apiHash: string;
  session: string;
}

export interface UserbotClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: TelegramMessage) => void): void;
  onMessageEdit(handler: (edit: TelegramMessageEdit) => void): void;
  onMessageDelete(handler: (del: TelegramMessageDelete) => void): void;
  fetchMessages(chatId: string, options: FetchOptions): Promise<TelegramMessage[]>;
  fetchSpecificMessages(chatId: string, messageIds: number[]): Promise<TelegramMessage[]>;
  raw(): TelegramClient;
  getSessionString(): string;
}

export interface FetchOptions {
  limit?: number;
  minId?: number;
  maxId?: number;
  offsetId?: number;
}

export function createUserbotClient(options: UserbotOptions, logger: Logger): UserbotClient {
  const log = logger.withContext('telegram:userbot');
  const session = new StringSession(options.session);
  const client = new TelegramClient(session, options.apiId, options.apiHash, {
    connectionRetries: 3,
  });

  patchGramjsLogger(client, log);

  const messageHandlers: Array<(msg: TelegramMessage) => void> = [];
  const editHandlers: Array<(edit: TelegramMessageEdit) => void> = [];
  const deleteHandlers: Array<(del: TelegramMessageDelete) => void> = [];
  let eventHandlerRegistered = false;

  function registerEventHandler() {
    if (eventHandlerRegistered) return;
    eventHandlerRegistered = true;

    client.addEventHandler(
      (event: NewMessageEvent) => {
        if (!event.message || event.message instanceof Api.MessageEmpty) return;
        const msg = event.message;
        const sender = resolveGramjsSender(msg);
        const telegramMsg = fromGramjsMessage(msg, sender);
        for (const handler of messageHandlers) {
          try {
            handler(telegramMsg);
          } catch (err) {
            log.withError(err).error('Message handler error');
          }
        }
      },
      new NewMessage({}),
    );

    client.addEventHandler(
      (event: EditedMessageEvent) => {
        if (!event.message || event.message instanceof Api.MessageEmpty) return;
        const msg = event.message;
        const sender = resolveGramjsSender(msg);
        const edit = fromGramjsEditedMessage(msg, sender);
        for (const handler of editHandlers) {
          try {
            handler(edit);
          } catch (err) {
            log.withError(err).error('Edit handler error');
          }
        }
      },
      new EditedMessage({}),
    );

    client.addEventHandler(
      (event: DeletedMessageEvent) => {
        const peer = event.peer instanceof Api.PeerChannel ? event.peer : undefined;
        const del = fromGramjsDeletedMessage(event.deletedIds, peer);
        for (const handler of deleteHandlers) {
          try {
            handler(del);
          } catch (err) {
            log.withError(err).error('Delete handler error');
          }
        }
      },
      new DeletedMessage({}),
    );

    log.log('Event handlers registered');
  }

  async function start() {
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
  }

  async function stop() {
    log.log('Disconnecting...');
    await client.disconnect();
    log.log('Disconnected');
  }

  async function fetchMessages(chatId: string, opts: FetchOptions): Promise<TelegramMessage[]> {
    const messages = await client.getMessages(chatId, {
      limit: opts.limit ?? 100,
      minId: opts.minId,
      maxId: opts.maxId,
      offsetId: opts.offsetId,
    });

    return messages
      .filter(m => !(m instanceof Api.MessageEmpty))
      .map(m => fromGramjsMessage(m, resolveGramjsSender(m)));
  }

  async function fetchSpecificMessages(chatId: string, messageIds: number[]): Promise<TelegramMessage[]> {
    if (messageIds.length === 0) return [];

    const messages = await client.getMessages(chatId, { ids: messageIds });

    return messages
      .filter(m => !(m instanceof Api.MessageEmpty))
      .map(m => fromGramjsMessage(m, resolveGramjsSender(m)));
  }

  return {
    start,
    stop,
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onMessageEdit(handler) {
      editHandlers.push(handler);
    },
    onMessageDelete(handler) {
      deleteHandlers.push(handler);
    },
    fetchMessages,
    fetchSpecificMessages,
    raw: () => client,
    getSessionString: () => String(client.session.save()),
  };
}
