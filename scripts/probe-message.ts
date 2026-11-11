/**
 * Dump teleproto's decoded representation of one message.
 *
 * Usage: pnpm tsx scripts/probe-message.ts <chatId> <messageId>
 */
import { writeFileSync } from 'node:fs';

import { useGlobalLogger, useLogger } from '@guiiai/logg';
import { Api } from 'teleproto';

import { loadConfig } from '../src/config/config';
import { loadUserbotSession } from '../src/telegram/session';
import { createUserbotClient } from '../src/telegram/userbot';

useGlobalLogger({ level: 'log', mode: 'pretty' });
const logger = useLogger('probe');

const [chatIdArg, messageIdArg] = process.argv.slice(2);
if (!chatIdArg || !messageIdArg) {
  console.error('Usage: pnpm tsx scripts/probe-message.ts <chatId> <messageId>');
  process.exit(1);
}
const messageId = Number(messageIdArg);
if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error(`Invalid messageId: ${messageIdArg}`);

const config = loadConfig();
const userbot = createUserbotClient({
  apiId: config.telegram.apiId,
  apiHash: config.telegram.apiHash,
  session: loadUserbotSession(config),
}, logger);

try {
  await userbot.start();
  logger.log('Connected. Fetching message...');
  const messages = await userbot.raw().getMessages(chatIdArg, { ids: [messageId] });
  const message = messages[0];
  if (!message) throw new Error(`Message ${messageId} not found in ${chatIdArg}`);
  const path = `/tmp/probe-teleproto-${chatIdArg}-${messageId}.json`;
  const dump = JSON.stringify(message, null, 2);
  writeFileSync(path, dump);
  logger.withFields({ path, size: dump.length }).log('Dumped');
  console.log('--- summary ---');
  console.log('class:', message.className);
  console.log('id:', message.id);
  console.log('text:', message.message.slice(0, 200));
  console.log('media:', message.media?.className ?? 'none');
  console.log('is service:', message instanceof Api.MessageService);
} finally {
  await userbot.stop();
}
