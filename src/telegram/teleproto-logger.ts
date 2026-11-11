import type { Logger } from '@guiiai/logg';
import { Logger as TeleprotoLogger } from 'teleproto';

export const createTeleprotoLogger = (logger: Logger): TeleprotoLogger => {
  const teleproto = new TeleprotoLogger();
  teleproto.handler = record => {
    const fields = { source: 'teleproto' };
    if (record.level === 'error') logger.withError(record.error).withFields(fields).error(record.message);
    else if (record.level === 'warn') logger.withFields(fields).warn(record.message);
    else if (record.level === 'info') logger.withFields(fields).log(record.message);
    else logger.withFields(fields).debug(record.message);
  };
  return teleproto;
};
