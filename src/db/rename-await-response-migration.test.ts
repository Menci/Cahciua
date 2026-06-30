import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  new URL('../../drizzle/0032_rename_await_response_to_still_working.sql', import.meta.url),
  'utf8',
);

const statements = migrationSql
  .split('--> statement-breakpoint')
  .map(statement => statement.trim())
  .filter(statement => statement.length > 0);

const createDatabase = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE turn_responses (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE probe_responses (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE turn_responses_v2 (
      id INTEGER PRIMARY KEY,
      entries TEXT NOT NULL
    );
    CREATE TABLE probe_responses_v2 (
      id INTEGER PRIMARY KEY,
      entries TEXT NOT NULL
    );
  `);
  return db;
};

const runMigration = (db: Database.Database): void => {
  for (const statement of statements) db.exec(statement);
};

const legacyArgs = JSON.stringify({ text: 'working', await_response: true });
const conflictingArgs = JSON.stringify({ text: 'working', await_response: true, still_working: false });
const mentionOnlyArgs = JSON.stringify({ text: 'Example: "await_response": true' });
const malformedArgs = '{"task":"done"}{"await_response":true,"text":"working"}';

interface StoredCall {
  name: string;
  arguments: string;
}

const assertMigratedCalls = (calls: StoredCall[]): void => {
  expect(JSON.parse(calls[0]!.arguments)).toEqual({ text: 'working', still_working: true });
  expect(JSON.parse(calls[1]!.arguments)).toEqual({ text: 'working', still_working: false });
  expect(calls[2]!.arguments).toBe(mentionOnlyArgs);
  expect(calls[3]!.arguments).toBe('{"task":"done"}{"still_working":true,"text":"working"}');
  expect(calls[4]!.arguments).toBe(legacyArgs);
};

describe('await_response database migration', () => {
  it('renames only send_message arguments in both legacy provider formats', () => {
    const db = createDatabase();

    try {
      const chatData = [{
        role: 'assistant',
        tool_calls: [
          { function: { name: 'send_message', arguments: legacyArgs } },
          { function: { name: 'send_message', arguments: conflictingArgs } },
          { function: { name: 'send_message', arguments: mentionOnlyArgs } },
          { function: { name: 'send_message', arguments: malformedArgs } },
          { function: { name: 'other_tool', arguments: legacyArgs } },
        ],
      }];
      const responsesData = chatData[0]!.tool_calls.map(({ function: call }) => ({
        type: 'function_call',
        name: call.name,
        arguments: call.arguments,
      }));

      for (const table of ['turn_responses', 'probe_responses']) {
        const insert = db.prepare(`INSERT INTO ${table} (id, provider, data) VALUES (?, ?, ?)`);
        insert.run(1, 'openai-chat', JSON.stringify(chatData));
        insert.run(2, 'responses', JSON.stringify(responsesData));
      }

      runMigration(db);

      for (const table of ['turn_responses', 'probe_responses']) {
        const chatRow = db.prepare(`SELECT data FROM ${table} WHERE id = 1`).get() as { data: string };
        const migratedChat = JSON.parse(chatRow.data) as { tool_calls: { function: StoredCall }[] }[];
        assertMigratedCalls(migratedChat[0]!.tool_calls.map(call => call.function));

        const responsesRow = db.prepare(`SELECT data FROM ${table} WHERE id = 2`).get() as { data: string };
        assertMigratedCalls(JSON.parse(responsesRow.data) as StoredCall[]);
      }
    } finally {
      db.close();
    }
  });

  it('preserves the V2 codec wrapper while migrating valid and malformed args', () => {
    const db = createDatabase();

    try {
      const entries = {
        _: [{
          kind: 'message',
          role: 'assistant',
          parts: [
            { kind: 'toolCall', callId: '1', name: 'send_message', args: legacyArgs },
            { kind: 'toolCall', callId: '2', name: 'send_message', args: conflictingArgs },
            { kind: 'toolCall', callId: '3', name: 'send_message', args: mentionOnlyArgs },
            { kind: 'toolCall', callId: '4', name: 'send_message', args: malformedArgs },
            { kind: 'toolCall', callId: '5', name: 'other_tool', args: legacyArgs },
          ],
        }],
        meta: { '/0/parts/5': 'test-marker' },
      };

      for (const table of ['turn_responses_v2', 'probe_responses_v2']) {
        db.prepare(`INSERT INTO ${table} (id, entries) VALUES (?, ?)`).run(1, JSON.stringify(entries));
      }

      runMigration(db);

      for (const table of ['turn_responses_v2', 'probe_responses_v2']) {
        const row = db.prepare(`SELECT entries FROM ${table}`).get() as { entries: string };
        const migrated = JSON.parse(row.entries) as {
          _: { parts: { name: string; args: string }[] }[];
          meta: Record<string, string>;
        };
        assertMigratedCalls(migrated._[0]!.parts.map(part => ({
          name: part.name,
          arguments: part.args,
        })));
        expect(migrated.meta).toEqual(entries.meta);
      }
    } finally {
      db.close();
    }
  });
});
