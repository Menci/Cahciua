/**
 * Recover messages missed while no client was connected.
 *
 * Message ids are contiguous within a supergroup, so a jump between two
 * persisted ids means the app was offline for that window. For each gap this
 * asks the userbot which ids still exist upstream and inserts only those;
 * ids Telegram already deleted are skipped because there is nothing to
 * recover. Backfilled events keep `receivedAtMs = date * 1000` so replay sorts
 * them by server time instead of the recovery time.
 *
 * Usage: pnpm tsx scripts/backfill-gaps.ts [--days 3] [--chat-id <id>] [--dry-run]
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { and, eq, gte } from 'drizzle-orm';

import { loadConfig } from '../src/config/config';
import { createDatabase, loadKnownChatIds, persistEvent, persistMessage, runMigrations } from '../src/db';
import { messages } from '../src/db/schema';
import { adaptMessage, adaptServiceEvent, isServiceMessage } from '../src/telegram/adaptation';
import { loadUserbotSession } from '../src/telegram/session';
import { createUserbotClient } from '../src/telegram/userbot';

initLogger(LogLevel.Log, Format.Pretty);
const logger = useLogger('backfill-gaps');

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const days = Number(flag('--days') ?? 3);
const onlyChat = flag('--chat-id');
const dryRun = argv.includes('--dry-run');
/** Upper bound that keeps a single request small; larger holes are listed for manual review. */
const MAX_GAP = 200;

const config = loadConfig();
const db = createDatabase(config.database.path, logger);
runMigrations(db, logger);
const userbot = createUserbotClient({
  apiId: config.telegram.apiId,
  apiHash: config.telegram.apiHash,
  session: loadUserbotSession(config),
}, logger);

const randomBetween = (loMs: number, hiMs: number): number => loMs + Math.floor(Math.random() * (hiMs - loMs + 1));

await userbot.start();
try {
  const sinceSeconds = Math.floor(Date.now() / 1000) - days * 86_400;
  const chatIds = onlyChat ? [onlyChat] : loadKnownChatIds(db);
  let recovered = 0;

  for (const chatId of chatIds) {
    const rows = db.select({ messageId: messages.messageId })
      .from(messages)
      .where(and(eq(messages.chatId, chatId), gte(messages.date, sinceSeconds)))
      .all()
      .map(row => Number(row.messageId))
      .sort((a, b) => a - b);

    const gaps: Array<[number, number]> = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!;
      const current = rows[i]!;
      if (current - prev > 1) gaps.push([prev, current]);
    }
    if (gaps.length === 0) continue;
    logger.withFields({ chatId, gaps: gaps.length }).log('Gap scan');

    for (const [prev, next] of gaps) {
      const size = next - prev - 1;
      if (size > MAX_GAP) {
        logger.withFields({ chatId, prev, next, size }).warn('Gap too large for automatic backfill');
        continue;
      }
      const ids = Array.from({ length: size }, (_, i) => prev + 1 + i);
      const fetched = await userbot.fetchSpecificMessages(chatId, ids);
      const found = new Set(fetched.map(message => message.messageId));
      const gone = ids.filter(id => !found.has(id));

      logger.withFields({ chatId, prev, next, size, recovered: fetched.length, gone: gone.length }).log('Gap inspected');
      if (dryRun) {
        for (const message of fetched) console.log(`  would recover ${message.messageId} ${new Date(message.date * 1000).toISOString()}`);
        continue;
      }
      const utcOffsetMin = -new Date().getTimezoneOffset();
      for (const message of fetched) {
        const enriched = { ...message, receivedAtMs: message.date * 1000, utcOffsetMin };
        if (isServiceMessage(enriched)) persistEvent(db, adaptServiceEvent(enriched));
        else persistEvent(db, adaptMessage(enriched));
        persistMessage(db, enriched);
        recovered++;
      }
      await sleep(randomBetween(500, 1_500));
    }
  }
  logger.withFields({ recovered, dryRun }).log('Gap backfill complete');
} finally {
  await userbot.stop();
  process.exit(0);
}
