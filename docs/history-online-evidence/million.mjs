// Measured token fixtures, isolated databases, built worker, default limits.
// Evidence stores hashes/counts/metrics only. No real archive or model calls.
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from '../../src/db/schema.ts';
import { defaultHistoryLimits } from '../../src/history/budget.ts';

const { values } = parseArgs({ options: { out: { type: 'string' }, fixtures: { type: 'string' }, cases: { type: 'string' } } });
if (!values.out || !values.fixtures || existsSync(values.out)) throw new Error('Expected --out NEW_DIRECTORY --fixtures TOKEN_JSON');
const directory = resolve(values.out);
mkdirSync(directory, { recursive: true });
const fixture = JSON.parse(readFileSync(values.fixtures, 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
for (const part of [...fixture.short, fixture.long, fixture.half]) {
  if (sha(part.text) !== part.sha256 || Buffer.byteLength(part.text) !== part.utf8Bytes) throw new Error('Token fixture identity mismatch');
}
const cases = [
  { name: 'reply-chain-1M', kind: 'messages', rows: 1000, chain: true, restart: true },
  { name: 'archive-1M-restart', kind: 'messages', rows: 1000, restart: true },
  { name: 'archive-10M', kind: 'messages', rows: 10000 },
  { name: 'single-message-1M', kind: 'long-message', rows: 1 },
  { name: 'single-TR-1M', kind: 'turn', rows: 1 },
].filter(item => !values.cases || values.cases.split(',').includes(item.name));
const reports = [];
for (const scenario of cases) {
  const archivePath = `${directory}/${scenario.name}-archive.db`;
  const historyPath = `${directory}/${scenario.name}-history.db`;
  const source = new Database(archivePath);
  source.pragma('journal_mode=WAL');
  const db = drizzle(source, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  const expected = new Map();
  let textTokens = 0;
  let bodyBytes = 0;
  const addMessage = (i, textPart, replyToMessageId) => {
    textTokens += textPart.tokens;
    bodyBytes += textPart.utf8Bytes;
    db.insert(schema.events).values({ chatId: 'fixture', type: 'message', messageId: String(i), receivedAtMs: i * 1000, timestampSec: i, utcOffsetMin: 0, sender: { id: 'user', displayName: 'User', isBot: false }, content: [{ type: 'text', text: textPart.text }], replyToMessageId }).run();
    expected.set(String(i), textPart);
  };
  source.transaction(() => {
    if (scenario.kind === 'turn') {
      textTokens = fixture.half.tokens * 2;
      bodyBytes = fixture.half.utf8Bytes * 2;
      const entries = [
        { kind: 'message', role: 'assistant', parts: [{ kind: 'text', text: fixture.half.text }, { kind: 'toolCall', callId: 'call', name: 'bash', args: '{}' }] },
        { kind: 'toolResult', callId: 'call', payload: fixture.half.text, requiresFollowUp: false },
      ];
      db.insert(schema.turnResponsesV2).values({ chatId: 'fixture', requestedAt: 1, modelName: 'fixture', entries: JSON.stringify({ _: entries, meta: {} }), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }).run();
    } else {
      for (let i = 1; i <= scenario.rows; i++) addMessage(i, scenario.kind === 'long-message' ? fixture.long : fixture.short[(i - 1) % fixture.short.length], scenario.chain && i > 1 ? String(i - 1) : undefined);
    }
  })();
  const largestSourceBytes = scenario.kind === 'turn'
    ? source.prepare('SELECT max(octet_length(entries)) AS n FROM turn_responses_v2').get().n
    : source.prepare('SELECT max(octet_length(content)) AS n FROM events').get().n;
  globalThis.gc?.();
  let reader;
  let current;
  let stderr = '';
  let status;
  let peakRssBytes = 0;
  const rssByPhase = new Map();
  let samplePhase = 'bootstrap';
  let killedCheckpoint;
  const began = performance.now();
  const sample = setInterval(() => {
    if (!current?.pid || current.exitCode !== null || current.signalCode !== null) return;
    try {
      const rss = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${current.pid}/status`, 'utf8'));
      if (rss) {
        const bytes = Number(rss[1]) * 1024;
        peakRssBytes = Math.max(peakRssBytes, bytes);
        rssByPhase.set(samplePhase, Math.max(rssByPhase.get(samplePhase) ?? 0, bytes));
      }
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }, 10);
  const start = () => {
    current = fork(resolve('dist/history-worker.mjs'), ['--history-worker', JSON.stringify({ archivePath, historyPath, generation: 'million' })], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    current.stderr.on('data', bytes => { stderr = `${stderr}${bytes}`.slice(-6000); });
  };
  const stop = async signal => {
    if (current.exitCode !== null || current.signalCode !== null) return;
    await new Promise(done => {
      const timer = setTimeout(() => current.kill('SIGKILL'), 2000);
      current.once('exit', () => { clearTimeout(timer); done(); });
      current.kill(signal);
    });
  };
  const waitFor = async predicate => {
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      if (current.exitCode !== null || current.signalCode !== null) throw new Error(`Worker exited: ${stderr}`);
      if (existsSync(historyPath)) reader ??= new Database(historyPath, { readonly: true });
      if (reader?.prepare("SELECT name FROM sqlite_master WHERE name='history_consumers'").get()) {
        const state = reader.prepare('SELECT status_json FROM history_consumers').get();
        if (state?.status_json) {
          status = JSON.parse(state.status_json);
          if (status.error || predicate()) return;
        }
      }
      await delay(50);
    }
    throw new Error('Scale acceptance deadline');
  };
  const checkpoints = () => reader.prepare("SELECT after_json FROM history_checkpoints WHERE source_kind='events'").get();
  try {
    start();
    if (scenario.restart) {
      const killAfter = scenario.chain ? 600 : 100;
      await waitFor(() => JSON.parse(checkpoints()?.after_json ?? 'null')?.id >= killAfter);
      if (!status.error) {
        killedCheckpoint = JSON.parse(checkpoints().after_json);
        await stop('SIGKILL');
        samplePhase = 'resumed';
        // Append a canonical edit while offline; the original event stays unchanged.
        const changedId = scenario.chain ? Math.floor(scenario.rows / 2) : 1;
        db.insert(schema.events).values({ chatId: 'fixture', type: 'edit', messageId: String(changedId), receivedAtMs: changedId * 1000 + 1, timestampSec: changedId, utcOffsetMin: 0, sender: { id: 'user', displayName: 'User', isBot: false }, content: [{ type: 'text', text: fixture.short[1].text }] }).run();
        textTokens += fixture.short[1].tokens;
        bodyBytes += fixture.short[1].utf8Bytes;
        expected.set(String(changedId), fixture.short[1]);
        start();
      }
    }
    await waitFor(() => status.baselineComplete && status.completedSourcePolls >= 2 && status.logLag === 0);
    if (!status.error && scenario.restart) {
      samplePhase = 'live';
      addMessage(scenario.rows + 1, fixture.short[0], scenario.chain ? String(scenario.rows) : undefined);
      const scanCycle = status.completedSourcePolls;
      await waitFor(() => status.baselineComplete && status.completedSourcePolls >= scanCycle + 2 && status.logLag === 0);
    }
  } finally {
    await stop('SIGTERM');
    clearInterval(sample);
  }
  const durationMs = performance.now() - began;
  let checkedBodies = 0;
  let checkedReplies = 0;
  const mismatches = [];
  const items = reader.prepare('SELECT count(*) AS n FROM history_items').get().n;
  if (!status.error) {
    for (const row of reader.prepare('SELECT item_json,search_text FROM history_items ORDER BY id').iterate()) {
      const item = JSON.parse(row.item_json);
      if (item.kind === 'message') {
        const body = expected.get(item.metadata.messageId);
        if (!body || sha(item.transcript.text) !== body.sha256) mismatches.push(item.key);
        checkedBodies++;
        if (scenario.chain && item.metadata.messageId !== '1') {
          const parentId = String(Number(item.metadata.messageId) - 1);
          if (item.metadata.replyTo?.messageId !== parentId || sha(item.transcript.reply?.text ?? '') !== expected.get(parentId).sha256) mismatches.push(`reply:${item.key}`);
          checkedReplies++;
        }
        const expectedSearch = [item.transcript.text, item.transcript.reply?.text].filter(Boolean).join('\n');
        if (row.search_text !== expectedSearch) mismatches.push(`search:${item.key}`);
      } else if (item.kind === 'model-output' || item.kind === 'tool-result') {
        const text = item.kind === 'model-output' ? item.parts.map(part => part.text).join('') : item.payload;
        if (sha(text) !== fixture.half.sha256 || row.search_text !== fixture.half.text) mismatches.push(item.key);
        checkedBodies++;
      } else if (item.kind === 'tool-execution' && item.pairing !== 'matched') mismatches.push(item.key);
    }
    if (items !== (scenario.kind === 'turn' ? 3 : expected.size)) mismatches.push('item-count');
    if (scenario.kind === 'turn' && reader.prepare('SELECT count(*) AS n FROM history_relations').get().n !== 4) mismatches.push('tool-relations');
    if (scenario.chain && checkedReplies !== expected.size - 1) mismatches.push('reply-count');
    if (reader.pragma('integrity_check', { simple: true }) !== 'ok') mismatches.push('sqlite-integrity');
    const verify = new Database(historyPath);
    verify.prepare("INSERT INTO history_fts(history_fts,rank) VALUES('integrity-check',1)").run();
    verify.close();
  }
  const phases = Object.fromEntries(rssByPhase);
  const report = { ...scenario, tokenizer: fixture.tokenizer, textTokens, bodyBytes, largestSourceBytes, durationMs, peakRssBytes, phases, killedCheckpoint, items, checkedBodies, checkedReplies, mismatches, fullContentVerified: !status.error && mismatches.length === 0, status, errorTail: stderr };
  reports.push(report);
  reader.close();
  source.close();
  writeFileSync(`${directory}/million.json`, JSON.stringify({ defaultHistoryLimits, builtWorker: true, usedDefaultLimits: true, sampleIntervalMs: 10, reports }, null, 2));
  console.log(JSON.stringify({ name: scenario.name, textTokens, items, checkedBodies, checkedReplies, peakRssBytes, peakEncodedWorkspaceBytes: status.peakEncodedWorkspaceBytes, durationMs, error: status.error, mismatches }));
  globalThis.gc?.();
}
if (reports.some(report => !report.fullContentVerified)) process.exitCode = 1;
