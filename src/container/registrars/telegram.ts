import { loadKnownChatIds } from '../../db';
import { createTelegramClients, createTelegramManager } from '../../telegram';
import { resolveBotDataDir, resolveUserbotDataDir } from '../../telegram/tdlib-paths';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export const registerTelegram = ({ get, register }: Registrar): void => {
  register(TOKENS.TELEGRAM_CLIENTS, () => {
    const config = get(TOKENS.CONFIG);
    return createTelegramClients({
      apiId: config.telegram.apiId,
      apiHash: config.telegram.apiHash,
      botToken: config.telegram.botToken,
      userbotEnabled: config.telegram.userbotEnabled,
      botDataDir: resolveBotDataDir(config),
      userbotDataDir: resolveUserbotDataDir(config),
    }, get(TOKENS.LOGGER));
  });

  register(TOKENS.TELEGRAM_MANAGER, () => {
    const db = get(TOKENS.DB);
    const media = get(TOKENS.MEDIA_RUNTIME);
    return createTelegramManager({
      initialChatIds: loadKnownChatIds(db),
      imageToTextResolvers: media.imageResolvers,
      animationToTextResolvers: media.animationResolvers,
      animationMaxFrames: media.animationMaxFrames,
      customEmojiToTextResolvers: media.customEmojiResolvers,
    }, get(TOKENS.TELEGRAM_CLIENTS), get(TOKENS.LOGGER));
  });
};
