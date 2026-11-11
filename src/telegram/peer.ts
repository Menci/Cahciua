import bigInt from 'big-integer';
import { Api, type TelegramClient } from 'teleproto';

export type ChatPeerResolver = (chatId: string | number) => Promise<Api.TypeInputPeer>;

/**
 * teleproto resolves entities from its session cache. A bot that never owns
 * ingress has no dialog updates, so configured supergroups must be resolved by
 * their channel id. `channels.getChannels` accepts accessHash 0 for a channel
 * the bot is a member of and returns the real access hash.
 */
export const createChatPeerResolver = (client: TelegramClient): ChatPeerResolver => {
  const cache = new Map<string, Api.TypeInputPeer>();

  return async chatIdRaw => {
    const chatId = String(chatIdRaw);
    const cached = cache.get(chatId);
    if (cached) return cached;

    let peer: Api.TypeInputPeer;
    if (/^-100\d+$/.test(chatId)) {
      const channelId = bigInt(chatId.slice(4));
      const result = await client.invoke(new Api.channels.GetChannels({
        id: [new Api.InputChannel({ channelId, accessHash: bigInt(0) })],
      }));
      const channel = result.chats.find((candidate): candidate is Api.Channel =>
        candidate instanceof Api.Channel && candidate.id.eq(channelId));
      if (channel?.accessHash == null)
        throw new Error(`Telegram did not return an accessible channel for ${chatId}`);
      peer = new Api.InputPeerChannel({ channelId, accessHash: channel.accessHash });
    } else if (/^-\d+$/.test(chatId)) {
      peer = new Api.InputPeerChat({ chatId: bigInt(chatId.slice(1)) });
    } else {
      peer = await client.getInputEntity(chatId);
    }

    cache.set(chatId, peer);
    return peer;
  };
};
