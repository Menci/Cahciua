import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { describe, expect, it } from 'vitest';

import { fromTeleprotoMessage } from './teleproto';

const userMap = new Map<string, unknown>([
  ['7', new Api.User({ id: bigInt(7), accessHash: bigInt('123'), firstName: 'Real Person', username: 'realperson' })],
]);

const contactMessage = (contact: Api.MessageMediaContact) => {
  const message = new Api.Message({
    id: 99,
    peerId: new Api.PeerChannel({ channelId: bigInt(100) }),
    fromId: new Api.PeerUser({ userId: bigInt(7) }),
    date: 1_800_000_000,
    message: '',
    media: contact,
  });
  message._finishInit({} as never, userMap as never);
  return message;
};

describe('shared contact adaptation', () => {
  it('keeps a bare phone contact instead of adapting an empty body', () => {
    const adapted = fromTeleprotoMessage(contactMessage(new Api.MessageMediaContact({
      phoneNumber: '+1 555 0100',
      firstName: 'Jose',
      lastName: 'Smith',
      vcard: 't.me/promo',
      userId: bigInt(0),
    })), 'userbot');
    expect(adapted?.contact).toEqual({
      phoneNumber: '+1 555 0100',
      firstName: 'Jose',
      lastName: 'Smith',
      vcard: 't.me/promo',
      userId: '0',
    });
  });

  it('keeps the linked account id when the card points at a Telegram user', () => {
    const adapted = fromTeleprotoMessage(contactMessage(new Api.MessageMediaContact({
      phoneNumber: '+1 555 0101',
      firstName: 'Real',
      lastName: 'Person',
      vcard: '',
      userId: bigInt(555),
    })), 'userbot');
    expect(adapted?.contact?.userId).toBe('555');
  });
});
