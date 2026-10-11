import { loadImageAltTextByHash, persistImageAltText } from '../../db';
import { createMediaRuntime } from '../../media/runtime';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export const registerMedia = ({ get, register }: Registrar): void => {
  register(TOKENS.MEDIA_RUNTIME, () => {
    const db = get(TOKENS.DB);
    const clients = get(TOKENS.TELEGRAM_CLIENTS);
    const history = get(TOKENS.HISTORY_ACCESS).enabled ? get(TOKENS.HISTORY_RUNTIME) : undefined;
    return createMediaRuntime({
      config: get(TOKENS.CONFIG),
      logger: get(TOKENS.LOGGER),
      lookupAltText: hash => loadImageAltTextByHash(db, hash),
      persistAltText: record => {
        persistImageAltText(db, record);
        history?.notifyMedia('image_alt_texts', record.imageHash);
      },
      getCustomEmojiInfo: ids => clients.bot.getCustomEmojiInfo(ids),
    });
  });
};
