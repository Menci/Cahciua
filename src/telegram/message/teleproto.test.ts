import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { describe, expect, it } from 'vitest';

import { fromTeleprotoMessage } from './teleproto';

const entityMap = new Map<string, unknown>([
  ['1', new Api.User({ id: bigInt(1), accessHash: bigInt('987654321'), firstName: 'Alice', username: 'alice' })],
  ['-100999', new Api.Channel({ id: bigInt(999), accessHash: bigInt('111'), title: '[KAI]的幣圈策略分享', username: 'kai_signals', photo: new Api.ChatPhotoEmpty(), date: 100 })],
]);

describe('teleproto message adaptation', () => {
  it('keeps the service-message sender resolved from the event entity map', () => {
    const message = new Api.MessageService({
      id: 7,
      peerId: new Api.PeerChannel({ channelId: bigInt(123) }),
      fromId: new Api.PeerUser({ userId: bigInt(1) }),
      date: 100,
      action: new Api.MessageActionChatAddUser({ users: [bigInt(2)] }),
    });
    const adapted = fromTeleprotoMessage(message, 'userbot', entityMap);
    expect(adapted).toMatchObject({
      messageId: 7,
      chatId: '-100123',
      sender: { id: '1', firstName: 'Alice', username: 'alice', accessHash: '987654321' },
      newChatMembers: [{ id: '2' }],
    });
  });

  it('adapts text, entities, media and in-chat reply metadata to canonical fields', () => {
    const message = new Api.Message({
      id: 8,
      peerId: new Api.PeerChannel({ channelId: bigInt(123) }),
      fromId: new Api.PeerUser({ userId: bigInt(1) }),
      date: 101,
      message: 'hello',
      entities: [new Api.MessageEntityBold({ offset: 0, length: 5 })],
      replyTo: new Api.MessageReplyHeader({ replyToMsgId: 7 }),
    });
    message._finishInit({} as never, entityMap as never);
    expect(fromTeleprotoMessage(message, 'userbot', entityMap)).toMatchObject({
      text: 'hello',
      entities: [{ type: 'bold', offset: 0, length: 5 }],
      replyToMessageId: 7,
      sender: { id: '1', accessHash: '987654321' },
    });
  });

  it('captures a cross-channel external reply with channel title, quote, and media without polluting replyToMessageId', () => {
    const message = new Api.Message({
      id: 110893,
      peerId: new Api.PeerChannel({ channelId: bigInt(3767048038) }),
      fromId: new Api.PeerUser({ userId: bigInt(1) }),
      date: 1795282489,
      message: '卧槽👿我他妈花钱进的策略频道现在直接进了？？？',
      entities: [new Api.MessageEntityBold({ offset: 0, length: 24 })],
      replyTo: new Api.MessageReplyHeader({
        replyToPeerId: new Api.PeerChannel({ channelId: bigInt(999) }),
        replyToMsgId: 42,
        replyFrom: new Api.MessageFwdHeader({
          date: 1795280000,
          fromId: new Api.PeerChannel({ channelId: bigInt(999) }),
          channelPost: 42,
        }),
        quoteText: '站住反彈了 先分批  #ETH    #BTC',
        replyMedia: new Api.MessageMediaPhoto({
          photo: new Api.Photo({
            id: bigInt(1),
            accessHash: bigInt(2),
            fileReference: Buffer.alloc(0),
            date: 100,
            sizes: [],
            dcId: 1,
          }),
        }),
      }),
    });

    const adapted = fromTeleprotoMessage(message, 'userbot', entityMap);
    expect(adapted?.replyToMessageId).toBeUndefined();
    expect(adapted?.replyQuote).toBeUndefined();
    expect(adapted?.externalReply).toEqual({
      origin: {
        date: 1795280000,
        fromChatId: '-100999',
        fromMessageId: 42,
        sender: {
          id: '-100999',
          firstName: '[KAI]的幣圈策略分享',
          username: 'kai_signals',
          isBot: false,
          isPremium: false,
        },
      },
      quote: { text: '站住反彈了 先分批  #ETH    #BTC' },
      mediaType: 'photo',
    });
  });
});
