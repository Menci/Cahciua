import bigInt from 'big-integer';
import { Api, type TelegramClient } from 'telegram';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTypingPollManager } from './typing-poll';
import { setupLogger, useLogger } from '../config/logger';

setupLogger();

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
};

const createClient = (peer: Api.InputPeerChat | Api.InputPeerChannel) => {
  const requests: unknown[] = [];
  const client = {
    getInputEntity: vi.fn(async () => peer),
    markAsRead: vi.fn(async () => true),
    invoke: vi.fn(async (request: unknown) => {
      requests.push(request);
      if (request instanceof Api.channels.GetFullChannel) {
        return {
          className: 'messages.ChatFull',
          fullChat: { pts: 10 },
        };
      }
      if (request instanceof Api.updates.GetChannelDifference) {
        return {
          className: 'updates.ChannelDifference',
          pts: 11,
          timeout: 30,
          otherUpdates: [
            new Api.UpdateChannelUserTyping({
              channelId: bigInt(456),
              fromId: new Api.PeerUser({ userId: bigInt(99) }),
              action: new Api.SendMessageTypingAction(),
            }),
          ],
        };
      }
      return true;
    }),
  };

  return {
    client: client as unknown as TelegramClient,
    requests,
    markAsRead: client.markAsRead,
  };
};

const updateStatusRequests = (requests: unknown[]) =>
  requests.filter((request): request is Api.account.UpdateStatus => request instanceof Api.account.UpdateStatus);

const channelDifferenceRequests = (requests: unknown[]) =>
  requests.filter(request => request instanceof Api.updates.GetChannelDifference);

describe('createTypingPollManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a shared online heartbeat and marks basic groups as read without channel polling', async () => {
    vi.useFakeTimers();

    const { client, requests, markAsRead } = createClient(new Api.InputPeerChat({ chatId: bigInt(123) }));
    const manager = createTypingPollManager(client, vi.fn(), useLogger('test'));

    await manager.startPolling('-123');

    expect(updateStatusRequests(requests).map(request => request.offline)).toEqual([false]);
    expect(markAsRead).toHaveBeenCalledWith(expect.any(Api.InputPeerChat));
    expect(channelDifferenceRequests(requests)).toEqual([]);

    await vi.advanceTimersByTimeAsync(50_000);
    expect(updateStatusRequests(requests).map(request => request.offline)).toEqual([false, false]);

    await manager.stopAll();
    expect(updateStatusRequests(requests).map(request => request.offline)).toEqual([false, false, true]);
  });

  it('polls supergroup channel differences and emits typing updates from otherUpdates', async () => {
    const onTyping = vi.fn();
    const { client, requests, markAsRead } = createClient(new Api.InputPeerChannel({
      channelId: bigInt(456),
      accessHash: bigInt(789),
    }));
    const manager = createTypingPollManager(client, onTyping, useLogger('test'));

    await manager.startPolling('-100456');

    expect(markAsRead).toHaveBeenCalledWith(expect.any(Api.InputPeerChannel));
    await vi.waitFor(() => expect(onTyping).toHaveBeenCalledWith({
      chatId: '-100456',
      userId: '99',
    }));
    expect(channelDifferenceRequests(requests)).toHaveLength(1);

    await manager.stopAll();
  });

  it('keeps one heartbeat for multiple active watches and stops it after the last watch', async () => {
    vi.useFakeTimers();

    const { client, requests } = createClient(new Api.InputPeerChat({ chatId: bigInt(123) }));
    const manager = createTypingPollManager(client, vi.fn(), useLogger('test'));

    await manager.startPolling('-123');
    await manager.startPolling('-456');

    expect(updateStatusRequests(requests).map(request => request.offline)).toEqual([false]);

    manager.stopPolling('-123');
    await vi.advanceTimersByTimeAsync(50_000);
    expect(updateStatusRequests(requests).map(request => request.offline)).toEqual([false, false]);

    manager.stopPolling('-456');
    await vi.advanceTimersByTimeAsync(50_000);
    expect(updateStatusRequests(requests).map(request => request.offline)).toEqual([false, false, true]);
  });

  it('does not leave presence active if a watch is stopped while peer resolution is pending', async () => {
    const peer = deferred<Api.InputPeerChat>();
    const requests: unknown[] = [];
    const markAsRead = vi.fn(async () => true);
    const client = {
      getInputEntity: vi.fn(async () => await peer.promise),
      markAsRead,
      invoke: vi.fn(async (request: unknown) => {
        requests.push(request);
        return true;
      }),
    };
    const manager = createTypingPollManager(client as unknown as TelegramClient, vi.fn(), useLogger('test'));

    const start = manager.startPolling('-123');
    manager.stopPolling('-123');
    peer.resolve(new Api.InputPeerChat({ chatId: bigInt(123) }));
    await start;

    expect(updateStatusRequests(requests)).toEqual([]);
    expect(markAsRead).not.toHaveBeenCalled();
  });
});
