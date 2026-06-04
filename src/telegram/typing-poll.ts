import type { Logger } from '@guiiai/logg';
import bigInt from 'big-integer';
import { Api, type TelegramClient } from 'telegram';

import type { TypingEvent } from './userbot';

export interface TypingPollManager {
  startPolling(chatId: string): Promise<void>;
  stopPolling(chatId: string): void;
  stopAll(): void;
}

interface PollState {
  timer: ReturnType<typeof setTimeout> | null;
  pts: number;
  channelId: bigInt.BigInteger;
  accessHash: bigInt.BigInteger;
  running: boolean;
}

const HEARTBEAT_THROTTLE_MS = 55_000;
const POLL_RETRY_MS = 30_000;
const DEFAULT_POLL_TIMEOUT_SEC = 30;

// MTProto only delivers UpdateChannelUserTyping to connections the server
// considers "online", so a passive userbot misses typing in large supergroups.
// While a chat is in its debounce window, actively poll getChannelDifference for
// typing updates (and keep the connection marked online via a throttled status
// heartbeat). Private chats and small groups still get typing via the normal
// update stream and don't need this.
export const createTypingPollManager = (
  client: TelegramClient,
  onTyping: (event: TypingEvent) => void,
  logger: Logger,
): TypingPollManager => {
  const log = logger.withContext('typing-poll');
  const polls = new Map<string, PollState>();

  let lastOnlineHeartbeatAt = 0;
  const sendOnlineHeartbeat = async () => {
    const now = Date.now();
    if (now - lastOnlineHeartbeatAt < HEARTBEAT_THROTTLE_MS) return;
    lastOnlineHeartbeatAt = now;
    try {
      await client.invoke(new Api.account.UpdateStatus({ offline: false }));
    } catch (err) {
      log.withError(err).warn('Failed to send online heartbeat');
    }
  };

  const parseSupergroupChannelId = (chatId: string): bigInt.BigInteger | null =>
    chatId.startsWith('-100') ? bigInt(chatId.slice(4)) : null;

  const pollLoop = async (state: PollState) => {
    if (!state.running) return;

    try {
      const result = await client.invoke(new Api.updates.GetChannelDifference({
        channel: new Api.InputChannel({ channelId: state.channelId, accessHash: state.accessHash }),
        filter: new Api.ChannelMessagesFilterEmpty(),
        pts: state.pts,
        limit: 100,
        force: false,
      }));

      const nextSec = 'timeout' in result && typeof result.timeout === 'number' ? result.timeout : DEFAULT_POLL_TIMEOUT_SEC;
      if ('pts' in result && typeof result.pts === 'number') state.pts = result.pts;

      const updates: Api.TypeUpdate[] = [];
      if ('newUpdates' in result && Array.isArray(result.newUpdates)) updates.push(...result.newUpdates);
      if ('otherUpdates' in result && Array.isArray(result.otherUpdates)) updates.push(...result.otherUpdates);

      for (const update of updates) {
        if (update instanceof Api.UpdateChannelUserTyping
          && update.action instanceof Api.SendMessageTypingAction
          && update.fromId instanceof Api.PeerUser) {
          onTyping({ chatId: `-100${String(state.channelId)}`, userId: String(update.fromId.userId) });
        }
      }

      if (state.running)
        state.timer = setTimeout(() => { void pollLoop(state); }, nextSec * 1000);
    } catch (err) {
      log.withError(err).withFields({ channelId: String(state.channelId) }).warn('getChannelDifference failed, retrying');
      if (state.running)
        state.timer = setTimeout(() => { void pollLoop(state); }, POLL_RETRY_MS);
    }
  };

  const startPolling = async (chatId: string) => {
    if (polls.has(chatId)) return;

    const channelId = parseSupergroupChannelId(chatId);
    if (!channelId) return;

    const entity = await client.getInputEntity(chatId).catch((err: unknown) => {
      log.withError(err).withFields({ chatId }).warn('Failed to resolve channel peer for typing poll');
      return undefined;
    });
    if (!(entity instanceof Api.InputPeerChannel)) return;
    const accessHash = entity.accessHash;

    await sendOnlineHeartbeat();

    let pts = 1;
    try {
      const full = await client.invoke(new Api.channels.GetFullChannel({
        channel: new Api.InputChannel({ channelId, accessHash }),
      }));
      if ('fullChat' in full && full.fullChat instanceof Api.ChannelFull)
        pts = full.fullChat.pts ?? 1;
    } catch (err) {
      log.withError(err).withFields({ chatId }).warn('Failed to seed channel pts, starting from 1');
    }

    // Re-check: an interleaved startPolling for the same chat may have won the race.
    if (polls.has(chatId)) return;
    const state: PollState = { timer: null, pts, channelId, accessHash, running: true };
    polls.set(chatId, state);
    log.withFields({ chatId, pts }).log('Started typing poll');
    void pollLoop(state);
  };

  const stopPolling = (chatId: string) => {
    const state = polls.get(chatId);
    if (!state) return;
    state.running = false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    polls.delete(chatId);
    log.withFields({ chatId }).log('Stopped typing poll');
  };

  const stopAll = () => {
    for (const chatId of [...polls.keys()]) stopPolling(chatId);
  };

  return { startPolling, stopPolling, stopAll };
};
