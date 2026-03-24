import type { Logger as LoggLogger } from '@guiiai/logg';
import { Logger } from 'telegram/extensions';

export const createGramjsLogger = (logger: LoggLogger): Logger => {
  const log = logger.withContext('gramjs');
  const levelMap: Record<string, (msg: string) => void> = {
    error: msg => log.error(msg),
    warn: msg => log.warn(msg),
    info: msg => log.verbose(msg),
    debug: msg => log.debug(msg),
  };
  const gramLogger = new Logger();
  gramLogger.log = (level, message) => {
    (levelMap[level] ?? log.debug.bind(log))(message);
  };
  return gramLogger;
};
