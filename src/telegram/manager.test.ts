import { useLogger } from '@guiiai/logg';
import { describe, expect, it } from 'vitest';

import type { BotClient } from './bot';
import type { IngressTelegramMessage } from './ingress-meta';
import { createTelegramManager } from './manager';
import type { TelegramMessage } from './message/types';
import type { UserbotClient } from './userbot';

const logger = useLogger('manager-test');
const chatId = '-1001';

const message = (messageId: number, date = messageId): TelegramMessage => ({
  messageId,
  chatId,
  sender: { id: '7', firstName: 'Alice', isBot: false, isPremium: false },
  date,
  text: `message ${messageId}`,
  source: 'userbot',
});

const createFakeUserbot = (params: {
  dialogTop: number;
  remote: TelegramMessage[];
  duringStart?: (emit: (msg: TelegramMessage) => void) => void;
}) => {
  const handlers: ((msg: TelegramMessage) => void)[] = [];
  const emit = (msg: TelegramMessage) => handlers.forEach(handler => handler(msg));
  const rangeRequests: [number, number][] = [];
  const userbot = {
    start: async () => { params.duringStart?.(emit); },
    stop: async () => {},
    onMessage: handler => { handlers.push(handler); },
    onMessageEdit: () => {},
    onMessageDelete: () => {},
    onTyping: () => {},
    fetchMessageRange: async (_chatId, afterId, throughId) => {
      rangeRequests.push([afterId, throughId]);
      return params.remote.filter(msg => msg.messageId > afterId && msg.messageId <= throughId);
    },
    dialogTopMessageIds: () => new Map([[chatId, params.dialogTop]]),
    raw: () => ({}) as never,
  } as Partial<UserbotClient> as UserbotClient;
  return { userbot, emit, rangeRequests };
};

const startManager = async (userbot: UserbotClient, archivedTop: number | undefined) => {
  const committed: IngressTelegramMessage[] = [];
  const bot = { start: async () => {}, stop: async () => {} } as Partial<BotClient> as BotClient;
  const manager = createTelegramManager({
    initialChatIds: [chatId],
    loadArchivedTopMessageId: () => archivedTop,
    imageToTextResolvers: new Map(),
    animationToTextResolvers: new Map(),
    animationMaxFrames: new Map(),
    customEmojiToTextResolvers: new Map(),
  }, { bot, userbot }, logger);
  manager.onMessage(msg => committed.push(msg));
  await manager.start();
  return committed;
};

const settle = async (committed: unknown[], count: number) => {
  for (let i = 0; i < 100 && committed.length < count; i++)
    await new Promise(resolve => setTimeout(resolve, 5));
};

describe('createTelegramManager startup recovery', () => {
  it('commits the missed tail before live ingress, observed at reconnect', async () => {
    const { userbot, emit } = createFakeUserbot({
      dialogTop: 13,
      remote: [message(10), message(11, 1_000), message(13, 1_002)],
      duringStart: emit => emit(message(14, 2_000)),
    });
    const startedAtMs = Date.now();
    const committed = await startManager(userbot, 10);
    emit(message(15, 2_001));
    await settle(committed, 4);

    expect(committed.map(msg => msg.messageId)).toEqual([11, 13, 14, 15]);
    const [first, second, held] = committed;
    expect(first!.receivedAtMs).toBeGreaterThanOrEqual(startedAtMs);
    expect(second!.receivedAtMs).toBe(first!.receivedAtMs);
    expect(held!.receivedAtMs).toBeGreaterThanOrEqual(first!.receivedAtMs);
    expect(first!.date).toBe(1_000);
  });

  it('drops live updates for ids already covered by recovery', async () => {
    const { userbot, emit } = createFakeUserbot({
      dialogTop: 12,
      remote: [message(11), message(12)],
      duringStart: emit => emit(message(12)),
    });
    const committed = await startManager(userbot, 10);
    emit(message(11));
    emit(message(13));
    await settle(committed, 3);

    expect(committed.map(msg => msg.messageId)).toEqual([11, 12, 13]);
  });

  it('skips chats that have no archive or are already up to date', async () => {
    const upToDate = createFakeUserbot({ dialogTop: 10, remote: [message(10)] });
    await startManager(upToDate.userbot, 10);
    expect(upToDate.rangeRequests).toEqual([]);

    const unarchived = createFakeUserbot({ dialogTop: 10, remote: [message(10)] });
    await startManager(unarchived.userbot, undefined);
    expect(unarchived.rangeRequests).toEqual([]);
  });
});
