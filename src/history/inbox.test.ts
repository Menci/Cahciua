import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';

import { createHistoryInbox } from './inbox';
import { parseHistoryDelivery } from './notifications';

it('migrates existing pending obligations without losing their targets and durably deduplicates receipt', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'history-inbox-'));
  const sqlite = new Database(resolve(dir, 'history.db'));
  try {
    // A pre-0004 database with outstanding responsibilities. The migration is
    // exercised as SQL against its actual old table shape, not a mock store.
    for (const tag of ['0000_plain_hemingway', '0001_online_consumption', '0002_readonly_sources', '0003_incremental_media']) sqlite.exec(readFileSync(resolve('history-drizzle', `${tag}.sql`), 'utf8'));
    sqlite.prepare('INSERT INTO history_pending_media VALUES (?, ?, ?, ?, ?)').run('g', 'events', '9', 'A', 10000);
    sqlite.prepare('INSERT INTO history_pending_media VALUES (?, ?, ?, ?, ?)').run('g', 'image_alt_texts', 'emoji:7', null, 10000);
    // Mark old migrations applied so Drizzle runs 0004 and later migrations on this old shape.
    sqlite.exec('CREATE TABLE __drizzle_migrations(id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)');
    sqlite.prepare('INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)').run('fixture', 1791635654608);
    migrate(drizzle(sqlite), { migrationsFolder: './history-drizzle' });
    expect(sqlite.prepare('SELECT source_kind, source_key, chat_id, scheduled_seq FROM history_pending_media ORDER BY id').all()).toEqual([
      { source_kind: 'events', source_key: '9', chat_id: 'A', scheduled_seq: null },
      { source_kind: 'image_alt_texts', source_key: 'emoji:7', chat_id: null, scheduled_seq: null },
    ]);
    const inbox = createHistoryInbox(sqlite, 'g');
    const input = { kind: 'media' as const, sourceKind: 'events' as const, sourceKey: '9' };
    inbox.receive(input); inbox.receive(input); expect(inbox.count()).toBe(1);
    sqlite.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON history_build_inputs BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
    expect(() => inbox.receive({ kind: 'recover' })).toThrow('receipt failure');
    expect(inbox.count()).toBe(1);
    sqlite.exec('DROP TRIGGER fail_receipt'); inbox.receive({ kind: 'recover' });
    expect(inbox.count()).toBe(3);
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('narrows bounded media locators and rejects malformed notification frames', () => {
  const input = { kind: 'media', sourceKind: 'events', sourceKey: '1' };
  expect(parseHistoryDelivery({ kind: 'history-input', id: 1, input })).toEqual({ kind: 'history-input', id: 1, input });
  for (const value of [null, {}, { kind: 'history-input', id: -1, input }, { kind: 'history-input', id: 1, input: { ...input, sourceKey: '-1' } }, { kind: 'history-input', id: 1, input: { ...input, sourceKey: 'x'.repeat(2000) } }]) expect(parseHistoryDelivery(value)).toBeUndefined();
});

it('rolls back both recovery responsibilities when dependency receipt fails', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'history-receipt-'));
  const sqlite = new Database(resolve(dir, 'history.db'));
  try {
    migrate(drizzle(sqlite), { migrationsFolder: './history-drizzle' });
    const inbox = createHistoryInbox(sqlite, 'g');
    sqlite.exec("CREATE TRIGGER fail_dependencies BEFORE INSERT ON history_build_inputs WHEN NEW.source_kind = 'dependencies' BEGIN SELECT RAISE(ABORT, 'dependency receipt failure'); END");
    expect(() => inbox.receive({ kind: 'recover' })).toThrow('dependency receipt failure');
    expect(inbox.count()).toBe(0);
    sqlite.exec('DROP TRIGGER fail_dependencies');
    inbox.receive({ kind: 'recover' });
    sqlite.exec("UPDATE history_build_inputs SET after_id = 4, upper_id = 9, after_key = 'a', upper_key = 'z'");
    inbox.receive({ kind: 'recover' });
    expect(sqlite.prepare("SELECT after_id, upper_id FROM history_build_inputs WHERE source_kind = 'pending'").get()).toEqual({ after_id: 0, upper_id: null });
    expect(sqlite.prepare("SELECT after_key, upper_key FROM history_build_inputs WHERE source_kind = 'dependencies'").get()).toEqual({ after_key: null, upper_key: null });
    expect(inbox.count()).toBe(2);
  } finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
});
