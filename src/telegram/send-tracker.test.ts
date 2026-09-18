import type * as Td from 'tdlib-types';
import { describe, expect, it } from 'vitest';

import { createSendTracker } from './send-tracker';

const tdMessage = (chatId: number, messageId: number): Td.message =>
  ({
    _: 'message',
    id: messageId,
    chat_id: chatId,
    date: 1789251600,
  }) as unknown as Td.message;

describe('createSendTracker', () => {
  it('resolves with the final server message on updateMessageSendSucceeded', async () => {
    const tracker = createSendTracker();
    const sent = tdMessage(-1002173016093, 1048577);
    const tracked = tracker.track(sent);
    const final = tdMessage(-1002173016093, 206700);

    tracker.settle({
      _: 'updateMessageSendSucceeded',
      message: final,
      old_message_id: 1048577,
    });

    expect(await tracked).toBe(final);
  });

  it('pairs yet-unsent ids per chat, not globally', async () => {
    const tracker = createSendTracker();
    const first = tracker.track(tdMessage(-1001, 1048577));
    const second = tracker.track(tdMessage(-1002, 1048577));
    const firstFinal = tdMessage(-1001, 11);
    const secondFinal = tdMessage(-1002, 22);

    tracker.settle({
      _: 'updateMessageSendSucceeded',
      message: secondFinal,
      old_message_id: 1048577,
    });
    tracker.settle({
      _: 'updateMessageSendSucceeded',
      message: firstFinal,
      old_message_id: 1048577,
    });

    expect(await first).toBe(firstFinal);
    expect(await second).toBe(secondFinal);
  });

  it('rejects with the TDLib error on updateMessageSendFailed', async () => {
    const tracker = createSendTracker();
    const tracked = tracker.track(tdMessage(-1001, 1048577));

    tracker.settle({
      _: 'updateMessageSendFailed',
      message: tdMessage(-1001, 5),
      old_message_id: 1048577,
      error: { _: 'error', code: 400, message: 'CHAT_WRITE_FORBIDDEN' },
    });

    await expect(tracked).rejects.toThrow('Telegram send failed (400): CHAT_WRITE_FORBIDDEN');
  });

  it('ignores terminal updates without a tracked send', () => {
    const tracker = createSendTracker();

    expect(() => tracker.settle({
      _: 'updateMessageSendSucceeded',
      message: tdMessage(-1001, 206700),
      old_message_id: 1048577,
    })).not.toThrow();
  });

  it('rejects every tracked send on abort', async () => {
    const tracker = createSendTracker();
    const first = tracker.track(tdMessage(-1001, 1048577));
    const second = tracker.track(tdMessage(-1002, 1048577));

    tracker.abort('client closed');

    await expect(first).rejects.toThrow('Telegram send abandoned: client closed');
    await expect(second).rejects.toThrow('Telegram send abandoned: client closed');
  });

  it('stops settling after abort', async () => {
    const tracker = createSendTracker();
    const tracked = tracker.track(tdMessage(-1001, 1048577));
    tracker.abort('client closed');
    tracker.settle({
      _: 'updateMessageSendSucceeded',
      message: tdMessage(-1001, 206700),
      old_message_id: 1048577,
    });

    await expect(tracked).rejects.toThrow('client closed');
  });
});
