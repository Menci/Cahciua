import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline/promises';

import { Format, initLogger, LogLevel, useGlobalLogger } from '@guiiai/logg';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

import { patchGramjsLogger } from './gramjs-logger';
import { loadSession, saveSession } from './session';
import { loadConfig } from '../config/config';

const main = async () => {
  initLogger(LogLevel.Log, Format.Pretty);
  const log = useGlobalLogger('login');

  const config = loadConfig();

  if (config.telegram.apiId == null || config.telegram.apiHash == null)
    throw new Error('telegram.apiId and telegram.apiHash are required for login');

  const existingSession = loadSession(config.telegram.session ?? '');

  const session = new StringSession(existingSession);
  const client = new TelegramClient(session, config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 3,
  });

  patchGramjsLogger(client, log);

  log.log('Connecting to Telegram...');
  await client.connect();

  const authorized = await client.isUserAuthorized();
  if (authorized) {
    log.log('Already authorized!');
    const sessionString = String(client.session.save());
    saveSession(sessionString);
    log.log('Session saved to data/session');
    await client.disconnect();
    return;
  }

  log.log('Not authorized. Starting interactive login...');

  const rl = readline.createInterface({ input: stdin, output: stdout });

  await client.start({
    phoneNumber: async () => {
      return await rl.question('Phone number (with country code, e.g. +86...): ');
    },
    phoneCode: async () => {
      return await rl.question('Verification code: ');
    },
    password: async () => {
      return await rl.question('2FA password: ');
    },
    onError: err => {
      log.withError(err).error('Login error');
    },
  });

  rl.close();

  const sessionString = String(client.session.save());
  saveSession(sessionString);
  log.log('Session saved to data/session');

  await client.disconnect();
};

main().catch(err => {
  useGlobalLogger('login').withError(err).error('Login failed');
  process.exit(1);
});
