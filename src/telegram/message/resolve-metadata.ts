import bigInt from 'big-integer';
import { Api, type TelegramClient } from 'teleproto';
import { StickersetInvalidError } from 'teleproto/errors';

import type { Attachment, MessageEntity, TelegramMessage, TelegramMessageEdit } from './types';

/**
 * Pack titles are display metadata. A set Telegram reports as invalid can never
 * become valid on retry, so it degrades to `undefined` instead of wedging the
 * chat; every other failure (network, flood wait, auth) stays retriable.
 */
const stickerSetIfReachable = async (
  client: TelegramClient,
  inputSet: Api.TypeInputStickerSet,
): Promise<Api.messages.StickerSet | undefined> => {
  try {
    const set = await client.getStickerSet(inputSet);
    return set instanceof Api.messages.StickerSet ? set : undefined;
  } catch (error) {
    if (error instanceof StickersetInvalidError) return undefined;
    throw error;
  }
};

const resolveAttachmentTitles = async (client: TelegramClient, attachments: Attachment[] | undefined): Promise<void> => {
  if (!attachments) return;
  await Promise.all(attachments.map(async att => {
    if (!att.stickerSetId || !att.stickerSetAccessHash || att.stickerSetName) return;
    const set = await stickerSetIfReachable(client, new Api.InputStickerSetID({
      id: bigInt(att.stickerSetId),
      accessHash: bigInt(att.stickerSetAccessHash),
    }));
    att.stickerSetName = set?.set.title ?? 'unknown';
  }));
};

const resolveCustomEmojiEntities = async (client: TelegramClient, entities: MessageEntity[] | undefined): Promise<void> => {
  if (!entities) return;
  const pending = entities.filter(e => e.type === 'custom_emoji' && e.customEmojiId && !e.customEmojiSetName);
  if (pending.length === 0) return;
  const ids = [...new Set(pending.map(e => e.customEmojiId!))];
  let documents: Api.TypeDocument[];
  try {
    documents = await client.getCustomEmojiDocuments(ids.map(id => bigInt(id)));
  } catch {
    for (const entity of pending) entity.customEmojiSetName = 'unknown';
    return;
  }
  const byId = new Map(documents.filter((d): d is Api.Document => d instanceof Api.Document).map(d => [String(d.id), d]));
  await Promise.all(pending.map(async entity => {
    const document = byId.get(entity.customEmojiId!);
    if (!document) {
      entity.customEmojiSetName = 'unknown';
      return;
    }
    const custom = document.attributes.find((a): a is Api.DocumentAttributeCustomEmoji => a instanceof Api.DocumentAttributeCustomEmoji);
    const sticker = document.attributes.find((a): a is Api.DocumentAttributeSticker => a instanceof Api.DocumentAttributeSticker);
    const inputSet = custom?.stickerset ?? sticker?.stickerset;
    const set = inputSet ? await stickerSetIfReachable(client, inputSet) : undefined;
    entity.customEmojiSetName = set?.set.title ?? 'unknown';
    entity.customEmojiSetId = set ? String(set.set.id) : undefined;
    entity.customEmojiFormat = document.mimeType === 'application/x-tgsticker'
      ? 'animated' : document.mimeType === 'video/webm' ? 'video' : 'static';
  }));
};

export const resolveMessageMetadata = async (client: TelegramClient, msg: TelegramMessage | TelegramMessageEdit): Promise<void> => {
  await Promise.all([
    resolveAttachmentTitles(client, msg.attachments),
    resolveCustomEmojiEntities(client, msg.entities),
  ]);
};
