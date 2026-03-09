import type { Logger } from '@guiiai/logg';
import type { TelegramClient } from 'telegram';

export function patchGramjsLogger(client: TelegramClient, logger: Logger) {
  const log = logger.withContext('gramjs');
  const levelMap: Record<string, (msg: string) => void> = {
    error: msg => log.error(msg),
    warn: msg => log.warn(msg),
    info: msg => log.verbose(msg),
    debug: msg => log.debug(msg),
  };
  (client as unknown as { _log: { log: (level: string, message: string) => void } })._log.log = (level, message) => {
    (levelMap[level] ?? log.debug.bind(log))(message);
  };
}
