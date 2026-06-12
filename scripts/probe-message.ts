/**
 * Probe a specific message via the userbot's tdlib client to inspect what TDLib
 * decodes from MTProto for that message. Dumps the full td_api.message tree.
 *
 * Usage: pnpm tsx scripts/probe-message.ts <chatId> <messageId>
 *   e.g. pnpm tsx scripts/probe-message.ts -1002173016093 187538
 *
 * Requires `pnpm login` to have populated the userbot tdlib data dir first.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { useGlobalLogger, useLogger } from '@guiiai/logg';
import * as tdl from 'tdl';
import type * as Td from 'tdlib-types';

import { loadConfig } from '../src/config/config';
import { resolveUserbotDataDir } from '../src/telegram/tdlib-paths';
import { resolveTdjson } from '../src/telegram/tdjson';

useGlobalLogger({ level: 'log', mode: 'pretty' });
const logger = useLogger('probe');

const [chatIdArg, messageIdArg] = process.argv.slice(2);
if (!chatIdArg || !messageIdArg) {
  console.error('Usage: pnpm tsx scripts/probe-message.ts <chatId> <messageId>');
  process.exit(1);
}

const chatId = Number(chatIdArg);
const mtprotoId = parseInt(messageIdArg, 10);
if (isNaN(mtprotoId)) throw new Error(`Invalid messageId: ${messageIdArg}`);
// TDLib message_id = MTProto id << 20.
const messageId = mtprotoId * (1 << 20);

const config = loadConfig();
tdl.configure({ tdjson: resolveTdjson() });

const dataDir = resolveUserbotDataDir(config);
mkdirSync(`${dataDir}/db`, { recursive: true });
mkdirSync(`${dataDir}/files`, { recursive: true });

const client = tdl.createClient({
  apiId: config.telegram.apiId,
  apiHash: config.telegram.apiHash,
  databaseDirectory: `${dataDir}/db`,
  filesDirectory: `${dataDir}/files`,
  tdlibParameters: {
    device_model: 'Cahciua probe',
    application_version: '1.0',
    use_message_database: true,
    use_chat_info_database: true,
    use_secret_chats: false,
  },
});

client.on('error', err => logger.withError(err).error('tdl client error'));

try {
  await client.login();
  logger.log('Connected. Fetching message...');

  // tdlib needs the chat to be "known" before getMessage can succeed —
  // an explicit getChat populates the local cache.
  try {
    await client.invoke({ _: 'getChat', chat_id: chatId });
  } catch (err) {
    logger.withError(err).warn('getChat failed (will try getMessage anyway)');
  }

  const msg = await client.invoke({
    _: 'getMessage',
    chat_id: chatId,
    message_id: messageId,
  }) as Td.message;

  const dump = JSON.stringify(msg, null, 2);
  const path = `/tmp/probe-tdlib-${chatId}-${messageId}.json`;
  writeFileSync(path, dump);
  logger.withFields({ path, size: dump.length }).log('Dumped');

  console.log('--- summary ---');
  console.log('class:', msg._);
  console.log('id:', msg.id);
  console.log('content class:', msg.content._);
  if (msg.content._ === 'messageText')
    console.log('text:', msg.content.text.text.slice(0, 200));
  if (msg.content._ === 'messageUnsupported')
    console.log('UNSUPPORTED — tdlib does not know how to decode this message type yet.');
  console.log('content keys:', Object.keys(msg.content).sort().join(', '));
} finally {
  await client.close();
}
