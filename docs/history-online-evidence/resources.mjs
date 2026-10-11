// Reproducible resource measurements: synthetic data only, one isolated child
// per case. /proc sampling measures child RSS independently of fixture setup.
import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import sharp from 'sharp';

import * as schema from '../../src/db/schema.ts';
import { defaultHistoryLimits } from '../../src/history/budget.ts';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (!values.out || existsSync(values.out)) throw new Error('Expected --out NEW_DIRECTORY');
const directory = resolve(values.out);
mkdirSync(directory, { recursive: true });
const mib = 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const content = bytes => `${'payload '.repeat(Math.ceil(bytes / 8)).slice(0, bytes - 11)} tailneedle`;
const cases = [
  { name: 'assistant-3MiB', bytes: 3 * mib, kind: 'assistant', rows: 1 },
  { name: 'tool-8MiB', bytes: 8 * mib, kind: 'tool', rows: 1 },
  { name: 'tool-32MiB', bytes: 32 * mib, kind: 'tool', rows: 1 },
  { name: 'image-16MiB', bytes: 16 * mib, kind: 'image', rows: 1 },
  { name: 'eight-tools-8MiB', bytes: 8 * mib, kind: 'tool', rows: 8 },
  { name: 'xml-escaping-1MiB', bytes: mib, kind: 'message', rows: 1 },
  { name: 'source-guard-64MiB', bytes: 64 * mib, kind: 'tool', rows: 1, expectError: true },
];
const reports = [];
for (const fixture of cases) {
  const archivePath = `${directory}/${fixture.name}-archive.db`;
  const historyPath = `${directory}/${fixture.name}-history.db`;
  const source = new Database(archivePath);
  source.pragma('journal_mode=WAL');
  const db = drizzle(source, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  let expectedHash;
  const populate = async () => {
    const text = fixture.kind === 'message' ? '&'.repeat(fixture.bytes) : content(fixture.bytes);
    const image = fixture.kind === 'image'
      ? (await sharp(randomBytes(2048 * 2048 * 3), { raw: { width: 2048, height: 2048, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()).toString('base64')
      : undefined;
    expectedHash = sha(text);
    for (let i = 0; i < fixture.rows; i++) {
      if (fixture.kind === 'message') {
        db.insert(schema.events).values({ chatId: 'fixture', type: 'message', messageId: String(i), receivedAtMs: i, timestampSec: i, utcOffsetMin: 0, content: [{ type: 'text', text }] }).run();
        continue;
      }
      const entries = fixture.kind === 'assistant'
        ? [{ kind: 'message', role: 'assistant', parts: [{ kind: 'text', text }] }]
        : fixture.kind === 'image'
          ? [{ kind: 'toolResult', callId: 'image', payload: [{ kind: 'image', image: { base64: image, format: 'png' }, detail: 'high' }], requiresFollowUp: false }]
          : [{ kind: 'toolResult', callId: 'tool', payload: text, requiresFollowUp: false }];
      const encoded = JSON.stringify({ _: entries, meta: fixture.kind === 'image' ? { '/0/payload/0/image': 'sharp' } : {} });
      db.insert(schema.turnResponsesV2).values({ chatId: 'fixture', requestedAt: i, modelName: 'fixture', entries: encoded, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }).run();
    }
  };
  await populate();
  const largestEncodedSourceBytes = fixture.kind === 'message'
    ? source.prepare('SELECT max(octet_length(content)) AS n FROM events').get().n
    : source.prepare('SELECT max(octet_length(entries)) AS n FROM turn_responses_v2').get().n;
  globalThis.gc?.();
  const child = fork(resolve('src/history/worker.ts'), ['--history-worker', JSON.stringify({ archivePath, historyPath, generation: 'resource' })], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = `${stderr}${bytes}`.slice(-4000); });
  let reader;
  let status;
  let peakRssBytes = 0;
  const began = performance.now();
  const sample = setInterval(() => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const path = `/proc/${child.pid}/status`;
    if (!existsSync(path)) return;
    try {
      const rss = /VmRSS:\s+(\d+) kB/.exec(readFileSync(path, 'utf8'));
      if (rss) peakRssBytes = Math.max(peakRssBytes, Number(rss[1]) * 1024);
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
    }
  }, 10);
  try {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child exited: ${stderr}`);
      if (existsSync(historyPath)) reader ??= new Database(historyPath, { readonly: true });
      if (reader?.prepare("SELECT name FROM sqlite_master WHERE name='history_consumers'").get()) {
        const row = reader.prepare('SELECT status_json FROM history_consumers').get();
        if (row?.status_json) {
          status = JSON.parse(row.status_json);
          if (fixture.expectError ? status.error : status.baselineComplete && status.logLag === 0) break;
        }
      }
      await delay(25);
    }
    if (!status || (fixture.expectError ? !status.error : !status.baselineComplete || status.error)) throw new Error(`Resource deadline/verification failed: ${stderr}`);
  } finally {
    await new Promise(resolveExit => {
      if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.once('exit', () => { clearTimeout(timer); resolveExit(); });
      child.kill('SIGTERM');
    });
    clearInterval(sample);
  }
  const durationMs = performance.now() - began;
  const rows = reader.prepare('SELECT item_json FROM history_items ORDER BY item_key').all();
  if (fixture.expectError) {
    if (rows.length !== 0 || reader.prepare("SELECT after_json FROM history_checkpoints WHERE source_kind='turn_responses_v2'").get().after_json !== null) throw new Error('Oversized source advanced bootstrap');
  } else {
    if (rows.length !== fixture.rows) throw new Error('Item count mismatch');
    for (const row of rows) {
      const item = JSON.parse(row.item_json);
      if (fixture.kind === 'image') {
        if (JSON.stringify(item.payload) !== '[{"kind":"image","position":{"entryIndex":0,"partIndex":0}}]') throw new Error('Image locator mismatch');
      } else {
        const saved = fixture.kind === 'assistant' ? item.parts[0].text : fixture.kind === 'message' ? item.transcript.text : item.payload;
        if (sha(saved) !== expectedHash) throw new Error('Full content mismatch');
      }
    }
    if (fixture.kind !== 'image' && fixture.kind !== 'message' && reader.prepare("SELECT count(*) AS n FROM history_fts WHERE history_fts MATCH 'tailneedle'").get().n !== fixture.rows) throw new Error('FTS tail missing');
  }
  reports.push({ ...fixture, largestEncodedSourceBytes, durationMs, peakRssBytes, status, items: rows.length, fullContentVerified: !fixture.expectError, retainedBootstrapOnError: !!fixture.expectError });
  reader.close();
  source.close();
  globalThis.gc?.();
}
writeFileSync(`${directory}/resources.json`, JSON.stringify({ defaultHistoryLimits, sampleIntervalMs: 10, reports }, null, 2));
console.log(JSON.stringify(reports.map(({ name, peakRssBytes, durationMs, status }) => ({ name, peakRssBytes, durationMs, peakEncodedWorkspaceBytes: status.peakEncodedWorkspaceBytes, error: !!status.error }))));
