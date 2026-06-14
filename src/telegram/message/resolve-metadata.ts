import type { Client } from 'tdl';
import type * as Td from 'tdlib-types';

import type { Attachment, MessageEntity, TelegramMessage, TelegramMessageEdit } from './types';

/**
 * Resolve a sticker pack's human-readable title via the same TDLib client
 * that just received the message containing the pack — at this moment the
 * pack's access_hash is in TDLib's in-memory `sticker_sets_` map. After the
 * client restarts the access_hash is gone and `getStickerSet` fails forever
 * (the set is opaque without access_hash at the MTProto layer), so resolution
 * MUST happen at ingress time.
 */
export const resolveStickerSetTitle = async (client: Client, setId: string): Promise<string> => {
  try {
    const set = await client.invoke({ _: 'getStickerSet', set_id: setId }) as Td.stickerSet;
    return set.title;
  } catch {
    try {
      const name = await client.invoke({ _: 'getStickerSetName', set_id: setId }) as Td.text;
      if (name.text) return name.text;
    } catch {
      // Both lookups failed — pack is unreachable for this client.
    }
    return 'unknown';
  }
};

const stickerFormatToCanonical = (format: Td.StickerFormat['_']): 'static' | 'animated' | 'video' => {
  switch (format) {
  case 'stickerFormatTgs': return 'animated';
  case 'stickerFormatWebm': return 'video';
  default: return 'static';
  }
};

const resolveAttachmentTitles = async (client: Client, attachments: Attachment[] | undefined): Promise<void> => {
  if (!attachments) return;
  await Promise.all(attachments.map(async att => {
    if (!att.stickerSetId || att.stickerSetName) return;
    att.stickerSetName = await resolveStickerSetTitle(client, att.stickerSetId);
  }));
};

const resolveCustomEmojiEntities = async (client: Client, entities: MessageEntity[] | undefined): Promise<void> => {
  if (!entities) return;
  const pending = entities.filter(e => e.type === 'custom_emoji' && e.customEmojiId && !e.customEmojiSetName);
  if (pending.length === 0) return;

  const ids = [...new Set(pending.map(e => e.customEmojiId!))];
  let infos: Td.sticker[];
  try {
    const result = await client.invoke({ _: 'getCustomEmojiStickers', custom_emoji_ids: ids }) as Td.stickers;
    infos = result.stickers;
  } catch {
    // The entire batch failed — mark all pending as unknown so we don't loop.
    for (const e of pending) e.customEmojiSetName = 'unknown';
    return;
  }

  const byId = new Map(infos.map(s => [String(s.id), s]));
  const setIdToTitle = new Map<string, string>();

  await Promise.all(pending.map(async e => {
    const sticker = byId.get(e.customEmojiId!);
    if (!sticker) {
      e.customEmojiSetName = 'unknown';
      return;
    }
    const setIdStr = String(sticker.set_id);
    if (setIdStr !== '0') e.customEmojiSetId = setIdStr;
    e.customEmojiFormat = stickerFormatToCanonical(sticker.format._);

    if (!e.customEmojiSetId) {
      e.customEmojiSetName = 'unknown';
      return;
    }
    let title = setIdToTitle.get(e.customEmojiSetId);
    if (!title) {
      title = await resolveStickerSetTitle(client, e.customEmojiSetId);
      setIdToTitle.set(e.customEmojiSetId, title);
    }
    e.customEmojiSetName = title;
  }));
};

export const resolveMessageMetadata = async (client: Client, msg: TelegramMessage | TelegramMessageEdit): Promise<void> => {
  await Promise.all([
    resolveAttachmentTitles(client, msg.attachments),
    resolveCustomEmojiEntities(client, msg.entities),
  ]);
};
