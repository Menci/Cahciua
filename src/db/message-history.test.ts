import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { loadEventsByMessageIds } from './persistence';
import * as schema from './schema';

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));

interface Row {
  chatId: string;
  type: 'message' | 'edit' | 'delete';
  receivedAtMs?: number;
  timestampSec?: number;
  messageId?: string;
  messageIds?: string[];
  content?: unknown;
}

const fixture = () => {
  const sqlite = new Database(':memory:');
  opened.push(sqlite);
  sqlite.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    type TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    utc_offset_min INTEGER NOT NULL DEFAULT 480,
    message_id TEXT,
    sender_id TEXT,
    text TEXT,
    message_ids TEXT,
    sender TEXT,
    content TEXT,
    attachments TEXT,
    reply_to_message_id TEXT,
    reply_quote_content TEXT,
    forward_info TEXT,
    is_self_sent INTEGER,
    service_action TEXT,
    runtime_data TEXT
  )`);
  const db = drizzle(sqlite, { schema });
  const insert = sqlite.prepare(`INSERT INTO events
    (chat_id, type, received_at, timestamp, message_id, message_ids, content)
    VALUES (@chatId, @type, @receivedAtMs, @timestampSec, @messageId, @messageIds, @content)`);
  const add = (row: Row) => insert.run({
    chatId: row.chatId,
    type: row.type,
    receivedAtMs: row.receivedAtMs ?? 0,
    timestampSec: row.timestampSec ?? 0,
    messageId: row.messageId ?? null,
    messageIds: row.messageIds ? JSON.stringify(row.messageIds) : null,
    content: row.content ? JSON.stringify(row.content) : null,
  });
  return { db, add };
};

describe('loadEventsByMessageIds', () => {
  it('returns message + edit events for the requested IDs, ordered by time', () => {
    const { db, add } = fixture();
    add({ chatId: 'chat', type: 'message', receivedAtMs: 1, messageId: '10', content: [{ type: 'text', text: 'ten' }] });
    add({ chatId: 'chat', type: 'edit', receivedAtMs: 2, messageId: '10', content: [{ type: 'text', text: 'ten (edited)' }] });
    add({ chatId: 'chat', type: 'message', receivedAtMs: 3, messageId: '20', content: [{ type: 'text', text: 'twenty' }] });
    add({ chatId: 'chat', type: 'message', receivedAtMs: 4, messageId: '30', content: [{ type: 'text', text: 'thirty' }] });

    const events = loadEventsByMessageIds(db, 'chat', ['10', '20']);
    expect(events.map(e => `${e.type}:${'messageId' in e ? e.messageId : ''}`)).toEqual(['message:10', 'edit:10', 'message:20']);
  });

  it('never returns another chat history', () => {
    const { db, add } = fixture();
    add({ chatId: 'chat', type: 'message', receivedAtMs: 1, messageId: '10', content: [{ type: 'text', text: 'mine' }] });
    add({ chatId: 'other', type: 'message', receivedAtMs: 2, messageId: '10', content: [{ type: 'text', text: 'theirs' }] });

    const events = loadEventsByMessageIds(db, 'chat', ['10']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ chatId: 'chat' });
  });

  it('matches delete events whose JSON message_ids array contains a requested ID', () => {
    const { db, add } = fixture();
    add({ chatId: 'chat', type: 'message', receivedAtMs: 1, messageId: '10', content: [{ type: 'text', text: 'ten' }] });
    add({ chatId: 'chat', type: 'delete', receivedAtMs: 2, messageIds: ['10'] });
    add({ chatId: 'chat', type: 'delete', receivedAtMs: 3, messageIds: ['99'] });
    add({ chatId: 'other', type: 'delete', receivedAtMs: 4, messageIds: ['10'] });

    const events = loadEventsByMessageIds(db, 'chat', ['10']);
    expect(events.filter(e => e.type === 'delete')).toHaveLength(1);
  });

  it('returns nothing for an empty ID list', () => {
    const { db } = fixture();
    expect(loadEventsByMessageIds(db, 'chat', [])).toEqual([]);
  });
});
