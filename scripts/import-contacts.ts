/**
 * Import contacts from a contacts.json (gramjs getContacts export) into the
 * current userbot account via contacts.AddContact, one at a time with delays.
 *
 * Usage: npx tsx scripts/import-contacts.ts [contacts.json path]
 * Default path: ./contacts.json or $CONTACTS_PATH
 */
import { readFileSync } from 'node:fs';

import { Format, initLogger, LogLevel, useGlobalLogger } from '@guiiai/logg';
import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

import { loadConfig } from '../src/config/config';
import { createGramjsLogger } from '../src/telegram/gramjs-logger';
import { loadSession } from '../src/telegram/session';

const DELAY_MS = 2000;

interface ContactUser {
  id: string;
  accessHash?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  deleted?: boolean;
  bot?: boolean;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const main = async () => {
  initLogger(LogLevel.Log, Format.Pretty);
  const log = useGlobalLogger('import-contacts');

  // Load contacts
  const contactsPath = process.argv[2] || process.env.CONTACTS_PATH || 'contacts.json';
  const data: { users?: ContactUser[] } = JSON.parse(readFileSync(contactsPath, 'utf-8'));
  const users = (data.users ?? []).filter(u => !u.deleted && u.accessHash);
  log.withFields({ path: contactsPath, total: data.users?.length, eligible: users.length }).log('Contacts loaded');

  if (users.length === 0) {
    log.warn('No eligible contacts to import');
    return;
  }

  // Connect userbot
  const config = loadConfig();
  if (config.telegram.apiId == null || config.telegram.apiHash == null)
    throw new Error('telegram.apiId and telegram.apiHash are required');

  const session = new StringSession(loadSession(config.telegram.session ?? ''));
  const client = new TelegramClient(session, config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 3,
    baseLogger: createGramjsLogger(log),
  });

  await client.connect();
  if (!(await client.isUserAuthorized()))
    throw new Error('Userbot session is not authorized. Run `pnpm login` first.');

  log.log('Connected');

  // Fetch existing contacts to skip
  const existing = await client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) }));
  const existingIds = new Set<string>();
  if (existing instanceof Api.contacts.Contacts) {
    for (const c of existing.contacts)
      existingIds.add(c.userId.toString());
  }
  log.withFields({ existing: existingIds.size }).log('Fetched existing contacts');

  const toImport = users.filter(u => !existingIds.has(u.id));
  log.withFields({ skipped: users.length - toImport.length, toImport: toImport.length }).log('Filtered');

  if (toImport.length === 0) {
    log.log('All contacts already exist, nothing to do');
    await client.disconnect();
    return;
  }

  // Import one by one with delay
  let success = 0;
  let failed = 0;
  for (let i = 0; i < toImport.length; i++) {
    const user = toImport[i]!;
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.id;

    try {
      await client.invoke(new Api.contacts.AddContact({
        id: new Api.InputUser({
          userId: bigInt(user.id),
          accessHash: bigInt(user.accessHash!),
        }),
        firstName: user.firstName ?? '',
        lastName: user.lastName ?? '',
        phone: user.phone ?? '',
      }));
      success++;
      log.withFields({ i: i + 1, total: toImport.length, id: user.id, name }).log('Added');
    } catch (err: any) {
      failed++;
      // Handle flood wait
      if (err?.errorMessage?.startsWith('FLOOD_WAIT_')) {
        const waitSec = Number.parseInt(err.errorMessage.split('_')[2]!, 10) || 30;
        log.withFields({ waitSec, id: user.id }).warn('Flood wait, sleeping...');
        await sleep(waitSec * 1000);
        i--; // retry this user
        failed--; // don't count as failed
        continue;
      }
      log.withFields({ id: user.id, name }).withError(err).error('Failed to add');
    }

    if (i < toImport.length - 1)
      await sleep(DELAY_MS);
  }

  log.withFields({ success, failed, total: toImport.length }).log('Import complete');
  await client.disconnect();
};

main().catch(err => {
  useGlobalLogger('import-contacts').withError(err).error('Fatal error');
  process.exit(1);
});
