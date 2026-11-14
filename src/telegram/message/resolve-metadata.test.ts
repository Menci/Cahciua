import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { StickersetInvalidError } from 'teleproto/errors';
import { describe, expect, it, vi } from 'vitest';

import { resolveMessageMetadata } from './resolve-metadata';
import type { Attachment, TelegramMessage } from './types';

const TITLE = 'Pack';

const client = (getStickerSet: (input: Api.TypeInputStickerSet) => Promise<unknown>) =>
  ({ getStickerSet, getCustomEmojiDocuments: vi.fn(async () => []) }) as never;

const stickerMessage = (): TelegramMessage => ({
  messageId: 1,
  chatId: '-1001',
  date: 0,
  text: '',
  source: 'userbot',
  attachments: [{
    type: 'sticker',
    stickerSetId: '42',
    stickerSetAccessHash: '1',
  } satisfies Attachment],
});

const reachable = () => new Api.messages.StickerSet({
  set: new Api.StickerSet({
    id: bigInt(42), accessHash: bigInt(1), title: TITLE, shortName: 'pack',
    count: 1, hash: 0,
  }),
  packs: [],
  keywords: [],
  documents: [],
});

/** Build the error the way teleproto's RPC layer does, so `instanceof` matches. */
const stickerSetInvalid = () => new StickersetInvalidError({
  request: new Api.messages.GetStickerSet({
    stickerset: new Api.InputStickerSetID({ id: bigInt(42), accessHash: bigInt(1) }),
    hash: 0,
  }),
});

describe('ingress metadata resolution', () => {
  it('records the pack title when the set is reachable', async () => {
    const message = stickerMessage();
    await resolveMessageMetadata(client(async () => reachable()), message);
    expect(message.attachments![0]!.stickerSetName).toBe(TITLE);
  });

  it('degrades to unknown when Telegram reports the set as invalid', async () => {
    const message = stickerMessage();
    await resolveMessageMetadata(client(async () => { throw stickerSetInvalid(); }), message);
    expect(message.attachments![0]!.stickerSetName).toBe('unknown');
  });

  it('propagates transient failures so the ingress queue keeps blocking', async () => {
    const message = stickerMessage();
    const failure = new Error('connection reset');
    await expect(resolveMessageMetadata(client(async () => { throw failure; }), message)).rejects.toBe(failure);
    expect(message.attachments![0]!.stickerSetName).toBeUndefined();
  });
});
