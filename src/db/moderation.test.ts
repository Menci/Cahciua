import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { findModerationAuthor, loadModerationMessageIds } from './moderation';
import * as schema from './schema';

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));

const fixture = () => {
  const sqlite = new Database(':memory:');
  opened.push(sqlite);
  sqlite.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
    CREATE TABLE events (
    id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, type TEXT NOT NULL,
    received_at INTEGER NOT NULL, timestamp INTEGER NOT NULL,
    message_id TEXT, sender_id TEXT
  )`);
  sqlite.prepare('INSERT INTO users (id, username) VALUES (?,?)').run('user', 'spammer');
  const db = drizzle(sqlite, { schema });
  const insert = sqlite.prepare('INSERT INTO events (chat_id,type,received_at,timestamp,message_id,sender_id) VALUES (?,?,?,?,?,?)');
  return { db, insert };
};

describe('moderation archive queries', () => {
  it('counts distinct observed speech across edits/deletes, excludes services, and scopes by chat', () => {
    const { db, insert } = fixture();
    insert.run('chat', 'message', 1, 1, '1', 'user');
    insert.run('chat', 'edit', 2, 2, '1', 'user');
    insert.run('chat', 'delete', 3, 3, null, null);
    insert.run('chat', 'message', 4, 4, '2', 'user');
    insert.run('chat', 'message', 5, 4, '2', 'user');
    insert.run('chat', 'edit', 6, 6, '3', 'user');
    insert.run('chat', 'service', 7, 7, null, 'user');
    insert.run('other-chat', 'message', 8, 8, '4', 'user');
    insert.run('chat', 'message', 9, 9, '5', 'other-user');
    expect(loadModerationMessageIds(db, 'chat', 'user')).toEqual([1, 2, 3]);
    expect(findModerationAuthor(db, 'chat', 4)).toBeUndefined();
    expect(findModerationAuthor(db, 'other-chat', 4)).toEqual({ userId: 'user', username: 'spammer' });
    expect(findModerationAuthor(db, 'chat', 5)).toEqual({ userId: 'other-user' });
  });

});
