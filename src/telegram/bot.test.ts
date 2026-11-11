import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { describe, expect, it, vi } from 'vitest';

import { createBotClient } from './bot';

const client = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  getMe: vi.fn(async () => ({ id: 123, firstName: 'Cahciua', username: 'cahciua_bot' })),
  addEventHandler: vi.fn(),
  invoke: vi.fn(async () => ({ chats: [new Api.Channel({ id: bigInt(1), accessHash: bigInt(123), title: 'chat', photo: new Api.ChatPhotoEmpty(), date: 0 })] })),
  sendMessage: vi.fn(),
  sendFile: vi.fn(),
  setTyping: vi.fn(),
  sendReaction: vi.fn(),
}));
vi.mock('teleproto/sessions', () => ({ StringSession: class {} }));
vi.mock('teleproto', async importOriginal => ({
  ...(await importOriginal<typeof import('teleproto')>()),
  TelegramClient: class {
    start = client.start;
    destroy = client.destroy;
    getMe = client.getMe;
    addEventHandler = client.addEventHandler;
    invoke = client.invoke;
    sendMessage = client.sendMessage;
    sendFile = client.sendFile;
    setTyping = client.setTyping;
    sendReaction = client.sendReaction;
  },
}));

const logger = {
  withContext: vi.fn(),
  withFields: vi.fn(),
  log: vi.fn(),
};
logger.withContext.mockReturnValue(logger);
logger.withFields.mockReturnValue(logger);

const bot = () => createBotClient({ apiId: 1, apiHash: 'hash', token: '123:token', sessionPath: '' }, logger as never);

describe('teleproto bot client', () => {
  it('sends plain text with HTML entities and no link preview', async () => {
    const sent = new Api.Message({ id: 5, date: 10, peerId: new Api.PeerChannel({ channelId: bigInt(1) }), message: 'hi' });
    client.sendMessage.mockResolvedValueOnce(sent);
    await expect(bot().sendMessage('-1001', '**hi**')).resolves.toEqual({ messageId: 5, date: 10, text: 'hi' });
    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ className: 'InputPeerChannel' }), {
      message: '<b>hi</b>', parseMode: 'html', replyTo: undefined, linkPreview: false,
    });
  });

  it.each([
    ['photo.bin', 'photo.jpg'],
    ['photo.webp', 'photo.jpg'],
    ['holiday.JPEG', 'holiday.JPEG'],
    ['holiday.png', 'holiday.png'],
  ])('names a photo %s as %s so teleproto sends it as a photo', async (requested, expected) => {
    const sent = new Api.Message({ id: 7, date: 12, peerId: new Api.PeerChannel({ channelId: bigInt(1) }), message: '' });
    client.sendFile.mockResolvedValueOnce(sent);
    await bot().sendPhoto('-1001', Buffer.from('img'), { fileName: requested });
    const [, params] = client.sendFile.mock.calls.at(-1)! as [unknown, { file: { name: string } }];
    expect(params.file.name).toBe(expected);
  });

  it('keeps a document name verbatim', async () => {
    const sent = new Api.Message({ id: 8, date: 13, peerId: new Api.PeerChannel({ channelId: bigInt(1) }), message: '' });
    client.sendFile.mockResolvedValueOnce(sent);
    await bot().sendDocument('-1001', Buffer.from('doc'), { fileName: 'report.bin' });
    const [, params] = client.sendFile.mock.calls.at(-1)! as [unknown, { file: { name: string } }];
    expect(params.file.name).toBe('report.bin');
  });

  it('sends a voice note as an uploaded buffer', async () => {
    const sent = new Api.Message({ id: 6, date: 11, peerId: new Api.PeerChannel({ channelId: bigInt(1) }), message: '' });
    client.sendFile.mockResolvedValueOnce(sent);
    const bytes = Buffer.from('voice');
    await expect(bot().sendVoice('-1001', bytes)).resolves.toMatchObject({ messageId: 6, date: 11 });
    expect(client.sendFile).toHaveBeenCalledWith(expect.objectContaining({ className: 'InputPeerChannel' }), expect.objectContaining({ voiceNote: true }));
  });
});
