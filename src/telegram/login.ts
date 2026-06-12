import { mkdirSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline/promises';

import { Format, initLogger, LogLevel, useGlobalLogger } from '@guiiai/logg';
import * as tdl from 'tdl';

import { loadConfig } from '../config/config';
import { resolveUserbotDataDir } from './tdlib-paths';
import { resolveTdjson } from './tdjson';

const main = async () => {
  initLogger(LogLevel.Log, Format.Pretty);
  const log = useGlobalLogger('login');

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
      device_model: 'Cahciua login',
      application_version: '1.0',
      use_message_database: true,
      use_chat_info_database: true,
      use_secret_chats: false,
    },
  });

  client.on('error', err => log.withError(err).error('tdl client error'));

  log.log('Connecting to Telegram...');

  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    await client.login({
      getPhoneNumber: async retry => {
        if (retry) log.error('Invalid phone number, please try again.');
        return await rl.question('Phone number (with country code, e.g. +86...): ');
      },
      getAuthCode: async retry => {
        if (retry) log.error('Invalid verification code, please try again.');
        return await rl.question('Verification code: ');
      },
      getPassword: async (hint, retry) => {
        if (retry) log.error('Invalid 2FA password, please try again.');
        return await rl.question(hint ? `2FA password (hint: ${hint}): ` : '2FA password: ');
      },
    });

    log.log('Logged in. Warming up tdlib state (initial chat list + user info)...');

    // Force tdlib to fetch initial state from the network and persist it to disk
    // BEFORE we close. Without this, the next start has to do all these round trips
    // first and any code that fires off requests in parallel hits transient
    // "not authorized" errors until the connection is fully bound + state is synced.
    await client.invoke({ _: 'getMe' });
    try {
      await client.invoke({ _: 'loadChats', chat_list: { _: 'chatListMain' }, limit: 500 });
    } catch (err) {
      // loadChats returns error 404 when there are no more chats; that's expected.
      log.withError(err).debug('loadChats returned (often expected: no more chats)');
    }
    // Give tdlib a moment to flush the freshly-fetched state to disk before close.
    // The closing handshake itself flushes too, but settle background tasks first.
    await new Promise(resolve => setTimeout(resolve, 1000));

    log.log('Userbot state saved to ' + dataDir);
  } finally {
    rl.close();
    await client.close();
  }
};

main().catch(err => {
  useGlobalLogger('login').withError(err).error('Login failed');
  process.exit(1);
});
