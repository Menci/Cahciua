import * as tdl from 'tdl';

import { contentToPlainText } from '../adaptation/content';
import { buildContainer } from '../container';
import { TOKENS } from '../container/tokens';
import { loadCompaction, loadEventsWithId, loadKnownChatIds, migrateV1ToV2 } from '../db';
import { selectStartupReplayChatIds } from './chat-selection';
import { resolveTdjson } from '../telegram/tdjson';

tdl.configure({ tdjson: resolveTdjson() });

export const startApp = async (): Promise<void> => {
  const container = buildContainer();
  const logger = container.get(TOKENS.LOGGER);
  const db = container.get(TOKENS.DB);
  try {
    await migrateV1ToV2(db, logger);
  } catch (error) {
    db.$client.close();
    try {
      await container.dispose();
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], 'Database migration and container disposal failed');
    }
    throw error;
  }

  const chatIds = container.get(TOKENS.CHAT_IDS);
  const media = container.get(TOKENS.MEDIA_RUNTIME);
  const pipeline = container.get(TOKENS.PIPELINE);
  const telegram = container.get(TOKENS.TELEGRAM_MANAGER);
  const driver = container.get(TOKENS.DRIVER);
  const driverInput = container.get(TOKENS.DRIVER_INPUT_BUS);
  const backgroundTasks = container.get(TOKENS.BACKGROUND_TASK_MANAGER);
  const liveHandlers = container.get(TOKENS.TELEGRAM_LIVE_HANDLERS);
  const postStartup = container.get(TOKENS.TELEGRAM_POST_STARTUP_TASKS);

  let telegramStartAttempted = false;
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      logger.log('Shutting down...');
      driverInput.deactivate();
      const errors: unknown[] = [];
      const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(driver.stop);
      await attempt(backgroundTasks.shutdown);
      if (telegramStartAttempted) await attempt(telegram.stop);
      await attempt(() => {
        db.$client.close();
      });
      await attempt(container.dispose);
      if (errors.length > 0) throw new AggregateError(errors, 'Application shutdown failed');
    })();
    return stopPromise;
  };

  const handleSignal = (): void => {
    void stop()
      .then(() => process.exit(0))
      .catch(error => {
        logger.withError(error).error('Shutdown failed');
        process.exit(1);
      });
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    const knownChatIds = loadKnownChatIds(db);
    const replayChatIds = selectStartupReplayChatIds(knownChatIds, chatIds);
    logger.withFields({
      knownSessions: knownChatIds.length,
      replaySessions: replayChatIds.length,
    }).log('Startup chat selection');

    for (const chatId of replayChatIds) {
      const compaction = loadCompaction(db, chatId);
      if (compaction) pipeline.setCompactCursor(chatId, compaction.newCursorMs);
      const events = loadEventsWithId(db, chatId, compaction?.newCursorMs).map(({ event }) => event);
      const imageResolver = media.imageResolvers.get(chatId);
      if (imageResolver) {
        await Promise.all(events.flatMap(event =>
          (event.type === 'message' || event.type === 'edit') && event.attachments.length > 0
            ? [imageResolver.hydrateCanonicalAttachments(
                event.attachments,
                contentToPlainText(event.content),
              )]
            : []));
      }
      for (const event of events) media.hydrateAltText(event);
      pipeline.replayChat(chatId, events);
    }
    logger.withFields({ sessions: pipeline.getRenderedChats().length }).log('Cold start complete');

    driverInput.attach(driver);
    liveHandlers.start();
    telegramStartAttempted = true;
    await telegram.start();
    driverInput.activate();
    backgroundTasks.recoverTasks();

    for (const [chatId, context] of pipeline.getRenderedChats())
      driverInput.handleEvent(chatId, context);

    logger.log('Cahciua is running');
    await postStartup.run();
  } catch (error) {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    try {
      await stop();
    } catch (shutdownError) {
      throw new AggregateError([error, shutdownError], 'Application startup and rollback failed');
    }
    throw error;
  }
};
