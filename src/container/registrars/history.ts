import { createHistoryAccess } from '../../history/access';
import { createHistoryRuntime, defaultHistoryOptions } from '../../history/runtime';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export const registerHistory = ({ get, register }: Registrar): void => {
  register(TOKENS.HISTORY_ACCESS, () => createHistoryAccess(get(TOKENS.CONFIG).history));
  register(TOKENS.HISTORY_RUNTIME, () => createHistoryRuntime({
    access: get(TOKENS.HISTORY_ACCESS),
    options: () => defaultHistoryOptions(get(TOKENS.CONFIG).database.path),
    logger: get(TOKENS.LOGGER),
  }));
};
