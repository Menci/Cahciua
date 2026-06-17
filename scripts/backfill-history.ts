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
 * For a freshly-joined group with no prior history, pass the id of the
 * most recent message you have seen (the bot's own join service message
 * works too).
 *
 * Pacing: between page fetches we sleep a uniform random 1-5 seconds to
 * stay well under any FloodWait threshold and avoid looking like a tight
 * scrape loop.
 *
 * Requires `pnpm login` to have populated the userbot tdlib data dir.
 * After backfill, add the chat id to `chats:` in config.yaml so cold-start
 * replay picks it up.
 */
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import * as tdl from 'tdl';
import type * as Td from 'tdlib-types';

import { adaptMessage, adaptServiceEvent, isServiceMessage } from '../src/adaptation';
import { loadConfig } from '../src/config/config';
import { createDatabase, persistEvent, persistMessage, runMigrations } from '../src/db';
import { resolveTdjson } from '../src/telegram/tdjson';
import { resolveUserbotDataDir } from '../src/telegram/tdlib-paths';
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
tdl.configure({ tdjson: resolveTdjson() });

const dataDir = resolveUserbotDataDir(config);
mkdirSync(`${dataDir}/db`, { recursive: true });
mkdirSync(`${dataDir}/files`, { recursive: true });

const userbot = createUserbotClient({
  apiId: config.telegram.apiId,
  apiHash: config.telegram.apiHash,
  databaseDirectory: `${dataDir}/db`,
  filesDirectory: `${dataDir}/files`,
}, logger);

const db = createDatabase(config.database.path, logger);
runMigrations(db, logger);

const resolveChatId = async (query: string): Promise<string> => {
  if (/^-?\d+$/.test(query)) return query;
  const raw = userbot.raw();
  const result = await raw.invoke({ _: 'searchChats', query, limit: 20 }) as Td.chats;
  const matches: { id: number; title: string }[] = [];
  for (const id of result.chat_ids) {
    const chat = await raw.invoke({ _: 'getChat', chat_id: id }) as Td.chat;
    matches.push({ id, title: chat.title });
  }
  if (matches.length === 0) throw new Error(`No chat matches "${query}"`);
  if (matches.length > 1) {
    console.error('Multiple matches — pass the numeric id instead:');
    for (const m of matches) console.error(`  ${m.id}\t${m.title}`);
    throw new Error('Ambiguous chat name');
  }
  logger.withFields(matches[0]!).log('Resolved chat');
  return String(matches[0]!.id);
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

  // Persist oldest-first so created_at matches conversation order.
  collected.reverse();
  const utcOffsetMin = -new Date().getTimezoneOffset();
  let persisted = 0;
  let services = 0;
  for (const msg of collected) {
    msg.receivedAtMs = msg.date * 1000;
    msg.utcOffsetMin = utcOffsetMin;

    if (isServiceMessage(msg)) {
      const ev = adaptServiceEvent(msg);
      if (ev) { persistEvent(db, ev); services++; }
    } else {
      persistEvent(db, adaptMessage(msg));
    }
    try { persistMessage(db, msg); } catch (err) { logger.withError(err).warn('persistMessage failed'); }
    persisted++;
  }

  logger.withFields({ chatId, persisted, services }).log('Backfill complete');
  console.log(`\nIf this chat is not yet configured, add to config.yaml under chats:\n  "${chatId}": {}\n`);
} finally {
  await userbot.stop();
  process.exit(0);
}
