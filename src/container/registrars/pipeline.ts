import { loadContacts } from '../../contacts';
import { createPipeline } from '../../pipeline';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export const registerPipeline = ({ get, register }: Registrar): void => {
  register(TOKENS.PIPELINE, () => {
    return createPipeline({
      botUserId: get(TOKENS.TELEGRAM_CLIENTS).bot.botUserId(),
      contactNames: loadContacts(get(TOKENS.LOGGER)),
    });
  });
};
