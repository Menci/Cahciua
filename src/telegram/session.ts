import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { StringSession } from 'teleproto/sessions';

import type { Config } from '../config/config';

const DEFAULT_SESSION_PATH = 'data/session';
const DEFAULT_BOT_SESSION_PATH = 'data/bot-session';

export const resolveUserbotSessionPath = (config: Config): string =>
  resolve(config.telegram.userbotSessionPath ?? DEFAULT_SESSION_PATH);

export const resolveBotSessionPath = (config: Config): string =>
  resolve(config.telegram.botSessionPath ?? DEFAULT_BOT_SESSION_PATH);

export const loadUserbotSession = (config: Config): StringSession => {
  const path = resolveUserbotSessionPath(config);
  try {
    return new StringSession(readFileSync(path, 'utf-8').trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`Userbot session not found at ${path}; run \`pnpm login\` first`);
    throw error;
  }
};

export const saveUserbotSession = (config: Config, session: StringSession): void => {
  const path = resolveUserbotSessionPath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, session.save(), { mode: 0o600 });
};
