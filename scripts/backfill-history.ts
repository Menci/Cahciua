/**
 * Backfill chat history into the DB via the userbot, as if it had been
 * watching the chat all along. Each backfilled message gets
 * `receivedAtMs = date * 1000` so events sort by server time.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-history.ts \
 *     --chat-id <id|name> --until <messageId> \
 *     [--max-days 30] [--max-messages 5000]
 *
 * `--until` is exclusive: history is walked strictly OLDER than this id.
 * Typical value is the earliest message id already persisted for the chat.
 *
 * Requires `pnpm login` to have created the userbot session.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';

import { loadConfig } from '../src/config/config';
import { createDatabase, persistEvent, persistMessage, runMigrations } from '../src/db';
import { adaptMessage, adaptServiceEvent, isServiceMessage } from '../src/telegram/adaptation';
import { loadUserbotSession } from '../src/telegram/session';
import { createUserbotClient } from '../src/telegram/userbot';

initLogger(LogLevel.Log, Format.Pretty);
const logger = useLogger('backfill-history');

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const chatIdArg = flag('--chat-id');
const untilArg = flag('--until');
if (!chatIdArg || !untilArg) {
  console.error('Usage: pnpm tsx scripts/backfill-history.ts \\');
  console.error('  --chat-id <id|name> --until <messageId> \\');
  console.error('  [--max-days 30] [--max-messages 5000]');
  process.exit(1);
}
const untilMessageId = Number(untilArg);
if (!Number.isFinite(untilMessageId) || untilMessageId <= 0) {
  throw new Error(`--until must be a positive integer message id, got ${untilArg}`);
}
const maxDays = Number(flag('--max-days') ?? 30);
const maxMessages = Number(flag('--max-messages') ?? 5000);

const config = loadConfig();
const userbot = createUserbotClient({
  apiId: config.telegram.apiId,
  apiHash: config.telegram.apiHash,
  session: loadUserbotSession(config),
}, logger);

const db = createDatabase(config.database.path, logger);
runMigrations(db, logger);

const resolveChatId = async (query: string): Promise<string> => {
  if (/^-?\d+$/.test(query)) return query;
  const dialogs = await userbot.raw().getDialogs({ limit: 500 });
  const matches = dialogs.filter(dialog => typeof dialog.title === 'string' && dialog.title.includes(query));
  if (matches.length === 0) throw new Error(`No chat matches "${query}"`);
  if (matches.length > 1) {
    console.error('Multiple matches — pass the numeric id instead:');
    for (const match of matches) console.error(`  ${match.id}\t${match.title}`);
    throw new Error('Ambiguous chat name');
  }
  const match = matches[0]!;
  logger.withFields({ id: String(match.id), title: match.title }).log('Resolved chat');
  return String(match.id);
};

const randomBetween = (loMs: number, hiMs: number): number =>
  loMs + Math.floor(Math.random() * (hiMs - loMs + 1));

await userbot.start();
try {
  const chatId = await resolveChatId(chatIdArg);
  const cutoffMs = Date.now() - maxDays * 86_400_000;
  logger.withFields({
    chatId, untilMessageId, maxDays, maxMessages,
    cutoffIso: new Date(cutoffMs).toISOString(),
  }).log('Backfill starting');

  const collected: Awaited<ReturnType<typeof userbot.fetchMessages>> = [];
  let offsetId = untilMessageId;
  let reachedCutoff = false;

  while (collected.length < maxMessages && !reachedCutoff) {
    const remaining = Math.min(100, maxMessages - collected.length);
    const batch = await userbot.fetchMessages(chatId, { limit: remaining, offsetId });
    if (batch.length === 0) break;

    for (const msg of batch) {
      if (msg.date * 1000 < cutoffMs) { reachedCutoff = true; break; }
      collected.push(msg);
      if (collected.length >= maxMessages) break;
    }
    offsetId = batch[batch.length - 1]!.messageId;
    logger.withFields({
      fetched: collected.length,
      oldestId: offsetId,
      oldestIso: new Date(batch[batch.length - 1]!.date * 1000).toISOString(),
      reachedCutoff,
    }).log('Page fetched');

    if (collected.length < maxMessages && !reachedCutoff) {
      const wait = randomBetween(1_000, 5_000);
      logger.withFields({ ms: wait }).log('Sleeping before next page');
      await sleep(wait);
    }
  }
  logger.withFields({ total: collected.length, reachedCutoff }).log('History fetch complete');

  collected.reverse();
  const utcOffsetMin = -new Date().getTimezoneOffset();
  let persisted = 0;
  let services = 0;
  for (const msg of collected) {
    const enriched = { ...msg, receivedAtMs: msg.date * 1000, utcOffsetMin };
    if (isServiceMessage(enriched)) {
      persistEvent(db, adaptServiceEvent(enriched));
      services++;
    } else {
      persistEvent(db, adaptMessage(enriched));
    }
    persistMessage(db, enriched);
    persisted++;
  }

  logger.withFields({ chatId, persisted, services }).log('Backfill complete');
  console.log(`\nIf this chat is not yet configured, add to config.yaml under chats:\n  "${chatId}": {}\n`);
} finally {
  await userbot.stop();
  process.exit(0);
}
