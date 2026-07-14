import { getChatIds, loadConfig } from '../../config/config';
import { useLogger } from '../../config/logger';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export const registerCore = ({ get, register }: Registrar): void => {
  register(TOKENS.LOGGER, () => useLogger('cahciua'));
  register(TOKENS.CONFIG, loadConfig);
  register(TOKENS.RUNTIME_CONFIG, () => get(TOKENS.CONFIG).runtime);
  register(TOKENS.BACKGROUND_TASKS_CONFIG, () => get(TOKENS.CONFIG).backgroundTasks);
  register(TOKENS.CHAT_IDS, () => getChatIds(get(TOKENS.CONFIG)));
  register(TOKENS.CONFIGURED_CHAT_IDS, () => new Set(get(TOKENS.CHAT_IDS)));
};
