import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { describe, expect, it } from 'vitest';

import { fromTeleprotoMessage } from './teleproto';

const entityMap = new Map<string, unknown>([
  ['1', new Api.User({ id: bigInt(1), accessHash: bigInt('987654321'), firstName: 'Alice', username: 'alice' })],
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
    message._finishInit({} as never, entityMap as never);
    const adapted = fromTeleprotoMessage(message, 'userbot');
    expect(adapted).toMatchObject({
      messageId: 7,
      chatId: '-100123',
      sender: { id: '1', firstName: 'Alice', username: 'alice', accessHash: '987654321' },
      newChatMembers: [{ id: '2' }],
    });
  });

  it('adapts text, entities, media and reply metadata to canonical fields', () => {
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
    expect(fromTeleprotoMessage(message, 'userbot')).toMatchObject({
      text: 'hello',
      entities: [{ type: 'bold', offset: 0, length: 5 }],
      replyToMessageId: 7,
      sender: { id: '1', accessHash: '987654321' },
    });
  });
});
