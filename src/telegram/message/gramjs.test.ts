import bigInt from 'big-integer';
import { Api } from 'telegram';
import { describe, expect, it } from 'vitest';

import { fromGramjsAnyMessage, fromGramjsServiceMessage } from './gramjs';
import { mergeTelegramMessageData } from './index';
import type { TelegramMessage } from './types';

const createServiceMessage = (options: {
  action: Api.TypeMessageAction;
  fromId?: Api.TypePeer;
  sender?: unknown;
  actionEntities?: unknown[];
  replyTo?: Api.TypeMessageReplyHeader;
}) => {
  const message = new Api.MessageService({
    id: 1,
    peerId: new Api.PeerChannel({ channelId: bigInt(123) }),
    date: 1_700_000_000,
    fromId: options.fromId,
    action: options.action,
    replyTo: options.replyTo,
  });

  (message as Api.MessageService & { _sender?: unknown; _actionEntities?: unknown[] })._sender = options.sender;
  (message as Api.MessageService & { _actionEntities?: unknown[] })._actionEntities = options.actionEntities;

  return message;
};

describe('fromGramjsServiceMessage', () => {
  it('keeps sender and member identities for chat add service messages', () => {
    const message = createServiceMessage({
      fromId: new Api.PeerUser({ userId: bigInt(99) }),
      sender: new Api.User({ id: bigInt(99), firstName: 'Admin', username: 'admin' }),
      action: new Api.MessageActionChatAddUser({ users: [bigInt(1), bigInt(2)] }),
      actionEntities: [
        new Api.User({ id: bigInt(1), firstName: 'Alice', lastName: 'Smith' }),
        new Api.User({ id: bigInt(2), firstName: 'Bob' }),
      ],
    });

    const result = fromGramjsServiceMessage(message);

    expect(result).toMatchObject({
      sender: { id: '99', firstName: 'Admin', username: 'admin' },
      newChatMembers: [
        { id: '1', firstName: 'Alice', lastName: 'Smith' },
        { id: '2', firstName: 'Bob' },
      ],
    });
  });

  it('supports anonymous admin service senders via sender chat', () => {
    const message = createServiceMessage({
      fromId: new Api.PeerChannel({ channelId: bigInt(777) }),
      sender: new Api.Channel({
        id: bigInt(777),
        title: 'Anonymous Admin',
        photo: new Api.ChatPhotoEmpty(),
        date: 1_700_000_000,
      }),
      action: new Api.MessageActionChatEditTitle({ title: 'New Group' }),
    });

    const result = fromGramjsServiceMessage(message);

    expect(result?.sender).toEqual({
      id: '-100777',
      firstName: 'Anonymous Admin',
      username: undefined,
      isBot: false,
      isPremium: false,
    });
  });
});

describe('fromGramjsAnyMessage', () => {
  it('routes service messages through the shared conversion path', () => {
    const message = createServiceMessage({
      fromId: new Api.PeerUser({ userId: bigInt(99) }),
      sender: new Api.User({ id: bigInt(99), firstName: 'Admin' }),
      action: new Api.MessageActionChatEditTitle({ title: 'Renamed' }),
    });

    const result = fromGramjsAnyMessage(message);

    expect(result).toMatchObject({
      source: 'userbot',
      newChatTitle: 'Renamed',
      sender: { id: '99', firstName: 'Admin' },
    });
  });
});

describe('mergeTelegramMessageData', () => {
  it('fills userbot service message metadata from the bot copy', () => {
    const target: TelegramMessage = {
      messageId: 1,
      chatId: '-100123',
      date: 1_700_000_000,
      text: '',
      source: 'userbot',
      sender: { id: '99', firstName: '', isBot: false, isPremium: false },
      newChatMembers: [{ id: '1', firstName: '', isBot: false, isPremium: false }],
      attachments: [{ type: 'photo' }],
    };

    const source: TelegramMessage = {
      messageId: 1,
      chatId: '-100123',
      date: 1_700_000_000,
      text: '',
      source: 'bot',
      sender: { id: '99', firstName: 'Admin', username: 'admin', isBot: false, isPremium: false },
      newChatMembers: [{ id: '1', firstName: 'Alice', username: 'alice', isBot: false, isPremium: false }],
      attachments: [{ type: 'photo', fileId: 'file-1', fileUniqueId: 'unique-1' }],
    };

    mergeTelegramMessageData(target, source);

    expect(target.sender).toMatchObject({ firstName: 'Admin', username: 'admin' });
    expect(target.newChatMembers?.[0]).toMatchObject({ firstName: 'Alice', username: 'alice' });
    expect(target.attachments?.[0]).toMatchObject({ fileId: 'file-1', fileUniqueId: 'unique-1' });
  });
});
