import { setupLogger, useLogger } from './config/logger';
import { startApp } from './startup';

setupLogger();
const logger = useLogger('cahciua');

startApp().catch(err => {
  logger.withError(err).error('Fatal error');
  process.exit(1);
});
