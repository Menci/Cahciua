import { readFile, access } from 'node:fs/promises';

import type * as Td from 'tdlib-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBotClient } from './bot';
import { setupLogger, useLogger } from '../config/logger';

const client = vi.hoisted(() => ({
  on: vi.fn<(event: string, handler: (update: unknown) => void) => void>(),
  invoke: vi.fn<(request: Td.getChat | Td.sendMessage) => Promise<unknown>>(),
}));
vi.mock('tdl', () => ({ createClient: () => client }));
setupLogger();

describe('bot media sends', () => {
  beforeEach(() => {
    client.on.mockClear();
    client.invoke.mockReset();
  });

  it.each(['voice', 'video_note'] as const)('sends %s with the current TDLib media object and keeps its file until confirmation', async kind => {
    const chatId = -100123;
    const pending = { _: 'message', chat_id: chatId, id: 1048577 } as unknown as Td.message;
    client.invoke.mockResolvedValue(pending);
    const bot = createBotClient({
      apiId: 1,
      apiHash: 'test',
      token: '123:test',
      databaseDirectory: '/tmp/cahciua-test-bot',
      filesDirectory: '/tmp/cahciua-test-files',
    }, useLogger('test'));
    const bytes = Buffer.from('test media');
    const sending = kind === 'voice' ? bot.sendVoice(chatId, bytes) : bot.sendVideoNote(chatId, bytes);
    await vi.waitFor(() => expect(client.invoke).toHaveBeenCalledWith(expect.objectContaining({ _: 'sendMessage' })));
    const request = client.invoke.mock.calls.map(([request]) => request).find(request => request._ === 'sendMessage');
    const content = request?.input_message_content;
    const media = content?._ === 'inputMessageVoiceNote' ? content.voice_note
      : content?._ === 'inputMessageVideoNote' ? content.video_note : undefined;
    expect(media).toMatchObject({ _: kind === 'voice' ? 'inputVoiceNote' : 'inputVideoNote', duration: 0 });
    const file = media?._ === 'inputVoiceNote' ? media.voice_note : media?.video_note;
    if (file?._ !== 'inputFileLocal' || !file.path) throw new Error('Expected a local media file');
    expect(await readFile(file.path)).toEqual(bytes);
    const handler = client.on.mock.calls.find(([event]) => event === 'update')?.[1];
    if (!handler) throw new Error('Expected Telegram update handler');
    handler({
      _: 'updateMessageSendSucceeded',
      old_message_id: pending.id,
      message: { ...pending, id: 2 * 1048576, date: 123, content: { _: 'messageUnsupported' } },
    });
    await expect(sending).resolves.toMatchObject({ messageId: 2, date: 123 });
    await expect(access(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
