import type { Logger } from '@guiiai/logg';
import type bigInt from 'big-integer';
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram';

import { isTypingLikeAction } from './typing-action';
import type { TypingEvent } from './userbot';

export interface TypingPollManager {
  startPolling(chatId: string): Promise<void>;
  stopPolling(chatId: string): void;
  stopAll(): Promise<void>;
}

type WatchKind = 'basic-group' | 'supergroup';

interface ChannelPollState {
  timer: ReturnType<typeof setTimeout> | null;
  pts: number;
  channelId: bigInt.BigInteger;
  accessHash: bigInt.BigInteger;
}

interface PollState {
  chatId: string;
  kind: WatchKind;
  peer: Api.InputPeerChat | Api.InputPeerChannel;
  running: boolean;
  channel?: ChannelPollState;
}

const HEARTBEAT_INTERVAL_MS = 50_000;

export const createTypingPollManager = (
  client: TelegramClient,
  onTyping: (event: TypingEvent) => void,
  logger: Logger,
): TypingPollManager => {
  const log = logger.withContext('typing-poll');
  const polls = new Map<string, PollState>();
  const starting = new Set<string>();
  const requested = new Set<string>();

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatInFlight = false;

  const sendOnlineHeartbeat = async () => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      await client.invoke(new Api.account.UpdateStatus({ offline: false }));
      log.withFields({ activeWatches: polls.size }).debug('Typing presence heartbeat sent');
    } catch (err) {
      log.withError(err).warn('Failed to send online heartbeat');
    } finally {
      heartbeatInFlight = false;
    }
  };

  const sendOfflineStatus = async () => {
    try {
      await client.invoke(new Api.account.UpdateStatus({ offline: true }));
      log.debug('Typing presence offline status sent');
    } catch (err) {
      log.withError(err).warn('Failed to send offline status');
    }
  };

  const startHeartbeat = async () => {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => { void sendOnlineHeartbeat(); }, HEARTBEAT_INTERVAL_MS);
    log.withFields({ intervalMs: HEARTBEAT_INTERVAL_MS }).debug('Typing presence heartbeat started');
    await sendOnlineHeartbeat();
  };

  const stopHeartbeat = (sendOffline: boolean) => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    log.debug('Typing presence heartbeat stopped');
    if (sendOffline) void sendOfflineStatus();
  };

  const resolveWatchPeer = async (chatId: string): Promise<PollState | null> => {
    try {
      const entity = await client.getInputEntity(chatId);
      if (entity instanceof Api.InputPeerChannel) {
        return {
          chatId,
          kind: 'supergroup',
          peer: entity,
          running: true,
          channel: {
            timer: null,
            pts: 1,
            channelId: entity.channelId,
            accessHash: entity.accessHash,
          },
        };
      }
      if (entity instanceof Api.InputPeerChat) {
        return {
          chatId,
          kind: 'basic-group',
          peer: entity,
          running: true,
        };
      }
      log.withFields({ chatId, peerClass: entity.className }).warn('Unsupported peer for typing presence');
      return null;
    } catch (err) {
      log.withError(err).withFields({ chatId }).warn('Failed to resolve peer for typing presence');
      return null;
    }
  };

  const markChatAsRead = async (state: PollState) => {
    try {
      await client.markAsRead(state.peer);
      log.withFields({ chatId: state.chatId, kind: state.kind }).debug('Marked chat as read for typing presence');
    } catch (err) {
      log.withError(err).withFields({ chatId: state.chatId, kind: state.kind }).warn('Failed to mark chat as read for typing presence');
    }
  };

  const extractTypingEvent = (update: Api.TypeUpdate, fallbackChatId?: string): TypingEvent | null => {
    if (update instanceof Api.UpdateChannelUserTyping) {
      if (!(update.fromId instanceof Api.PeerUser) || !isTypingLikeAction(update.action)) return null;
      return {
        chatId: fallbackChatId ?? `-100${update.channelId.toString()}`,
        userId: update.fromId.userId.toString(),
      };
    }
    if (update instanceof Api.UpdateChatUserTyping) {
      if (!(update.fromId instanceof Api.PeerUser) || !isTypingLikeAction(update.action)) return null;
      return {
        chatId: fallbackChatId ?? `-${update.chatId.toString()}`,
        userId: update.fromId.userId.toString(),
      };
    }
    return null;
  };

  const pollLoop = async (state: PollState) => {
    if (!state.running || !state.channel) return;

    try {
      const result = await client.invoke(new Api.updates.GetChannelDifference({
        channel: new Api.InputChannel({
          channelId: state.channel.channelId,
          accessHash: state.channel.accessHash,
        }),
        filter: new Api.ChannelMessagesFilterEmpty(),
        pts: state.channel.pts,
        limit: 100,
        force: false,
      }));

      const nextSec = 'timeout' in result && typeof result.timeout === 'number' ? result.timeout : 30;
      if ('pts' in result && typeof result.pts === 'number') {
        state.channel.pts = result.pts;
      }

      const updates: Api.TypeUpdate[] = [];
      if ('otherUpdates' in result && Array.isArray(result.otherUpdates)) {
        updates.push(...result.otherUpdates);
      }

      let typingCount = 0;
      for (const update of updates) {
        const event = extractTypingEvent(update, state.chatId);
        if (event) {
          typingCount++;
          onTyping(event);
        }
      }

      log.withFields({
        chatId: state.chatId,
        pts: state.channel.pts,
        timeoutSec: nextSec,
        typingCount,
        resultClass: result.className,
      }).debug('Channel difference poll completed');

      if (state.running) {
        state.channel.timer = setTimeout(() => { void pollLoop(state); }, nextSec * 1000);
      }
    } catch (err) {
      log.withError(err).withFields({ chatId: state.chatId }).warn('getChannelDifference failed, retrying in 30s');
      if (state.running) {
        state.channel.timer = setTimeout(() => { void pollLoop(state); }, 30_000);
      }
    }
  };

  const startPolling = async (chatId: string) => {
    requested.add(chatId);
    if (polls.has(chatId) || starting.has(chatId)) return;
    starting.add(chatId);

    try {
      const state = await resolveWatchPeer(chatId);
      if (!state) {
        requested.delete(chatId);
        return;
      }
      if (!requested.has(chatId)) return;

      polls.set(chatId, state);
      await startHeartbeat();
      if (!state.running || !requested.has(chatId)) return;
      await markChatAsRead(state);
      if (!state.running || !requested.has(chatId)) return;

      if (state.channel) {
        try {
          const full = await client.invoke(new Api.channels.GetFullChannel({
            channel: new Api.InputChannel({
              channelId: state.channel.channelId,
              accessHash: state.channel.accessHash,
            }),
          }));
          const channelFull = 'fullChat' in full ? (full.fullChat as Api.ChannelFull) : null;
          state.channel.pts = channelFull?.pts ?? 1;
          log.withFields({ chatId, pts: state.channel.pts }).debug('Seeded channel pts for typing presence');
        } catch (err) {
          log.withError(err).withFields({ chatId }).warn('Failed to seed channel pts, starting from 1');
        }
        if (!state.running || !requested.has(chatId)) return;

        void pollLoop(state);
        log.withFields({ chatId }).debug('Started channel difference poll');
      }

      log.withFields({ chatId, kind: state.kind }).debug('Started typing presence watch');
    } finally {
      starting.delete(chatId);
    }
  };

  const stopPollingInternal = (chatId: string, sendOfflineIfIdle: boolean) => {
    requested.delete(chatId);
    const state = polls.get(chatId);
    if (!state) return;
    state.running = false;
    if (state.channel?.timer) {
      clearTimeout(state.channel.timer);
      state.channel.timer = null;
    }
    polls.delete(chatId);
    log.withFields({ chatId, kind: state.kind }).debug('Stopped typing presence watch');
    if (sendOfflineIfIdle && polls.size === 0)
      stopHeartbeat(true);
  };

  const stopPolling = (chatId: string) => {
    stopPollingInternal(chatId, true);
  };

  const stopAll = async () => {
    requested.clear();
    for (const chatId of polls.keys())
      stopPollingInternal(chatId, false);
    if (heartbeatTimer)
      stopHeartbeat(false);
    await sendOfflineStatus();
  };

  return { startPolling, stopPolling, stopAll };
};
