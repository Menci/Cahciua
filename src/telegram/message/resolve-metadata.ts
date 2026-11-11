import bigInt from 'big-integer';
import { Api, type TelegramClient } from 'teleproto';

import type { Attachment, MessageEntity, TelegramMessage, TelegramMessageEdit } from './types';

const resolveStickerSetTitle = async (
  client: TelegramClient,
  setId: string,
  accessHash: string,
): Promise<string> => {
  const set = await client.getStickerSet(new Api.InputStickerSetID({
    id: bigInt(setId),
    accessHash: bigInt(accessHash),
  }));
  return set instanceof Api.messages.StickerSet ? set.set.title : 'unknown';
};

const resolveAttachmentTitles = async (client: TelegramClient, attachments: Attachment[] | undefined): Promise<void> => {
  if (!attachments) return;
  await Promise.all(attachments.map(async att => {
    if (!att.stickerSetId || !att.stickerSetAccessHash || att.stickerSetName) return;
    att.stickerSetName = await resolveStickerSetTitle(client, att.stickerSetId, att.stickerSetAccessHash);
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
    if (inputSet) {
      const set = await client.getStickerSet(inputSet);
      entity.customEmojiSetName = set instanceof Api.messages.StickerSet ? set.set.title : 'unknown';
      entity.customEmojiSetId = set instanceof Api.messages.StickerSet ? String(set.set.id) : undefined;
      entity.customEmojiFormat = document.mimeType === 'application/x-tgsticker'
        ? 'animated' : document.mimeType === 'video/webm' ? 'video' : 'static';
    } else {
      entity.customEmojiSetName = 'unknown';
    }
  }));
};

export const resolveMessageMetadata = async (client: TelegramClient, msg: TelegramMessage | TelegramMessageEdit): Promise<void> => {
  await Promise.all([
    resolveAttachmentTitles(client, msg.attachments),
    resolveCustomEmojiEntities(client, msg.entities),
  ]);
};
