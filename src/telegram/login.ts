import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline/promises';

import { Format, initLogger, LogLevel, useGlobalLogger } from '@guiiai/logg';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';

import { saveUserbotSession } from './session';
import { loadConfig } from '../config/config';

const main = async () => {
  initLogger(LogLevel.Log, Format.Pretty);
  const log = useGlobalLogger('login');
  const config = loadConfig();
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const client = new TelegramClient(new StringSession(''), config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 3,
  });

  try {
    log.log('Connecting to Telegram...');
    await client.start({
      phoneNumber: async () => await rl.question('Phone number (with country code, e.g. +86...): '),
      phoneCode: async () => await rl.question('Verification code: '),
      password: async hint => await rl.question(hint ? `2FA password (hint: ${hint}): ` : '2FA password: '),
      onError: error => {
        log.withError(error).error('Login failed');
      },
    });

    const me = await client.getMe();
    log.withFields({ id: String(me.id), username: me.username }).log('Authenticated');
    await client.getDialogs({ limit: 500 });

    saveUserbotSession(config, client.session);
    log.log('Userbot session saved');
  } finally {
    rl.close();
    await client.disconnect();
  }
};

main().catch(error => {
  useGlobalLogger('login').withError(error).error('Login failed');
  process.exit(1);
});
