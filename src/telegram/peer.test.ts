import bigInt from 'big-integer';
import { Api, type TelegramClient } from 'teleproto';
import { describe, expect, it, vi } from 'vitest';

import { createChatPeerResolver } from './peer';

const fixture = () => {
  const invoke = vi.fn(async () => ({
    chats: [new Api.Channel({
      id: bigInt(3767048038),
      accessHash: bigInt(123456),
      title: 'Project Memoh',
      photo: new Api.ChatPhotoEmpty(),
      date: 0,
    })],
  }));
  const client = { invoke } as unknown as TelegramClient;
  return { invoke, resolve: createChatPeerResolver(client) };
};

describe('chat peer resolver', () => {
  it('resolves a configured supergroup from its channel id and caches it', async () => {
    const f = fixture();
    const peer = await f.resolve('-1003767048038');
    expect(peer).toMatchObject({ className: 'InputPeerChannel' });
    expect(await f.resolve('-1003767048038')).toBe(peer);
    expect(f.invoke).toHaveBeenCalledOnce();
  });

  it('builds a basic-group peer without a network call', async () => {
    const f = fixture();
    expect(await f.resolve('-12345')).toMatchObject({ className: 'InputPeerChat' });
    expect(f.invoke).not.toHaveBeenCalled();
  });
});
