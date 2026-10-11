import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspect } from 'node:util';

import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { createHistoryArchive } from '../db/history-archive';
import { loadImageAltTextByHash } from '../db/persistence';
import * as archiveSchema from '../db/schema';
import { createCachedAltTextHydrator } from '../media/alt-text-cache';
import type { RenderParams } from '../rendering';
import { defaultHistoryLimits, checkHistoryLimits } from './budget';
import type { HistoryLimits } from './budget';
import { createHistoryInbox } from './inbox';
import { parseHistoryDelivery } from './notifications';
import { createOnlineHistoryBuilder } from './online';
import { consumers } from './schema';
import { openHistoryStore } from './store';

export interface HistoryWorkerOptions {
  readonly archivePath: string;
  readonly historyPath: string;
  readonly generation?: string;
  readonly limits?: Partial<HistoryLimits>;
  readonly renderParams?: { botUserId?: string; contactNames?: readonly (readonly [string, string])[] };
}
export const runHistoryWorker = async (options: HistoryWorkerOptions): Promise<void> => {
  const archivePath = realpathSync(options.archivePath);
  if (archivePath === resolve(options.historyPath)) throw new Error('Archive and history paths must differ');
  const archiveStat = statSync(archivePath);
  const historyStat = existsSync(options.historyPath) ? statSync(options.historyPath) : undefined;
  if (historyStat?.dev === archiveStat.dev && historyStat.ino === archiveStat.ino) throw new Error('Archive and history database paths must differ');
  const limits = { ...defaultHistoryLimits, ...options.limits };
  checkHistoryLimits(limits);
  const renderParams: RenderParams = { botUserId: options.renderParams?.botUserId, contactNames: new Map(options.renderParams?.contactNames) };
  const renderIdentity = createHash('sha256').update(JSON.stringify(options.renderParams ?? {})).digest('hex');
  const generation = options.generation ?? `incremental-v3-${renderIdentity.slice(0, 16)}`;
  const sqlite = new Database(archivePath, { readonly: true, fileMustExist: true });
  sqlite.pragma('cache_size = -2048');
  sqlite.pragma('temp_store = FILE');
  sqlite.pragma('busy_timeout = 250');
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  // The IPC channel belongs to the parent lifecycle; an orphan never remains a
  // second history writer after its supervisor starts a replacement child.
  process.once('disconnect', stop);
  let store: ReturnType<typeof openHistoryStore> | undefined;
  let message: ((value: unknown) => void) | undefined;
  try {
    const db = drizzle(sqlite, { schema: archiveSchema });
    store = openHistoryStore(options.historyPath);
    const builder = createOnlineHistoryBuilder({
      db, archive: createHistoryArchive(db), store, generation, archiveIdentity: archivePath, renderIdentity, renderParams, limits,
      hydrateAltText: (event, reserve) => createCachedAltTextHydrator({
        enabled: () => true, lookup: hash => {
          const cached = loadImageAltTextByHash(db, hash, Math.min(limits.maxSourceBytes, limits.maxWorkspaceBytes));
          if (cached) reserve(Buffer.byteLength(JSON.stringify(cached)));
          return cached;
        },
      })(event),
    });
    const inbox = createHistoryInbox(store.sqlite, generation);
    // Startup is also recovery of a producer that exited after media commit but
    // before IPC delivery. Persist this obligation before advertising readiness.
    inbox.receive({ kind: 'recover' });
    message = (value: unknown) => {
      if (abort.signal.aborted) return;
      const input = parseHistoryDelivery(value);
      if (!input) return;
      try {
        inbox.receive(input.input);
        if (process.connected) process.send?.({ kind: 'received', id: input.id }, error => { if (error && !abort.signal.aborted) process.stderr.write(`${inspect(error)}\n`); });
      } catch (error) {
        // No ACK on failed receipt. The asynchronous sender retains/retries it;
        // no failure is delivered back to ingress or the media producer.
        process.stderr.write(`${inspect(error, { depth: 5 })}\n`);
      }
    };
    process.on('message', message);
    if (process.connected) process.send?.({ kind: 'ready' }, error => { if (error && !abort.signal.aborted) process.stderr.write(`${inspect(error)}\n`); });
    let lastStatus = 0;
    let totalRows = 0;
    const began = performance.now();
    while (!abort.signal.aborted) {
      const started = performance.now();
      let error: string | null = null;
      let processedRows = 0;
      try { processedRows = (await builder.step(abort.signal)).processedRows; } catch (cause) {
        error = inspect(cause, { depth: 5 });
      }
      totalRows += processedRows;
      if (error || Date.now() - lastStatus >= 1000) {
        const snapshot = { ...builder.status(), coverage: undefined, status: undefined };
        const fileBytes = (path: string) => existsSync(path) ? statSync(path).size : 0;
        const status = {
          ...snapshot, error, totalRows, rowsPerSecond: totalRows * 1000 / (performance.now() - began), batchMs: performance.now() - started,
          updatedAt: Date.now(), archiveWalBytes: fileBytes(`${archivePath}-wal`), historyWalBytes: fileBytes(`${options.historyPath}-wal`), historyBytes: fileBytes(options.historyPath),
        };
        store.db.update(consumers).set({ status }).where(eq(consumers.generation, generation)).run();
        lastStatus = Date.now();
        if (error) process.stderr.write(`${error}\n`);
      }
      // Errors retain task/checkpoint; retry slowly so an operator can raise
      // worker budgets and restart against the same generation without skips.
      await delay(error ? 5000 : processedRows ? Math.max(1, Math.ceil(1000 / limits.rowsPerSecond - (performance.now() - started))) : 250, undefined, { signal: abort.signal }).catch(cause => {
        if (!abort.signal.aborted) throw cause;
      });
    }
  } finally {
    if (message) process.off('message', message);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    process.off('disconnect', stop);
    store?.close();
    sqlite.close();
    if (process.connected) process.disconnect();
  }
};

// This is also the built distribution child entry. JSON options are supplied
// by the supervisor, never read from Telegram/model input.
if (process.argv[2] === '--history-worker') {
  await runHistoryWorker(JSON.parse(process.argv[3]!) as HistoryWorkerOptions).catch((cause: unknown) => {
    process.stderr.write(`${inspect(cause, { depth: 5 })}\n`);
    process.exitCode = 1;
  });
}
