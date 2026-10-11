import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspect, parseArgs } from 'node:util';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { buildHistorySlice } from './bootstrap';
import { checkHistoryLimits, defaultHistoryLimits } from './budget';
import { openHistoryStore } from './store';
import { createHistoryArchive } from '../db/history-archive';
import { loadImageAltTextByHash } from '../db/persistence';
import * as schema from '../db/schema';
import { createCachedAltTextHydrator } from '../media/alt-text-cache';

const run = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      archive: { type: 'string' }, history: { type: 'string' }, generation: { type: 'string' }, chat: { type: 'string', multiple: true },
      'rows-per-slice': { type: 'string' }, 'rows-per-second': { type: 'string' }, 'source-bytes': { type: 'string' },
      'workspace-bytes': { type: 'string' }, 'state-entries': { type: 'string' }, 'output-items': { type: 'string' },
    },
  });
  if (!values.archive || !values.history || !values.generation || !values.chat?.length) {
    throw new Error('Usage: pnpm exec tsx src/history/cli.ts --archive data/bot.db --history data/history.db --generation NAME --chat CHAT_ID [--chat CHAT_ID ...]');
  }
  const archivePath = realpathSync(values.archive);
  const historyPath = resolve(values.history);
  const archiveStat = statSync(archivePath);
  const historyStat = existsSync(historyPath) ? statSync(historyPath) : undefined;
  if (archivePath === historyPath || (historyStat?.dev === archiveStat.dev && historyStat.ino === archiveStat.ino)) throw new Error('Archive and history database paths must differ');
  const limits = {
    maxRowsPerSlice: Number(values['rows-per-slice'] ?? defaultHistoryLimits.maxRowsPerSlice),
    rowsPerSecond: Number(values['rows-per-second'] ?? defaultHistoryLimits.rowsPerSecond),
    maxSourceBytes: Number(values['source-bytes'] ?? defaultHistoryLimits.maxSourceBytes),
    maxWorkspaceBytes: Number(values['workspace-bytes'] ?? defaultHistoryLimits.maxWorkspaceBytes),
    maxStateEntries: Number(values['state-entries'] ?? defaultHistoryLimits.maxStateEntries),
    maxOutputItems: Number(values['output-items'] ?? defaultHistoryLimits.maxOutputItems),
  };
  checkHistoryLimits(limits);
  const sqlite = new Database(archivePath, { readonly: true, fileMustExist: true });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    sqlite.pragma('cache_size = -2048');
    sqlite.pragma('temp_store = FILE');
    sqlite.pragma('busy_timeout = 5000');
    const db = drizzle(sqlite, { schema });
    const archive = createHistoryArchive(db);
    const store = openHistoryStore(historyPath);
    try {
      for (const chatId of values.chat) {
        for (;;) {
          const result = await buildHistorySlice({
            archive, store, generation: values.generation, chatId, archiveIdentity: archivePath,
            renderIdentity: 'cached-alt-text-v1', limits, signal: abort.signal,
            hydrateAltText: (event, reserve) => createCachedAltTextHydrator({
              enabled: () => true,
              lookup: hash => {
                const cached = loadImageAltTextByHash(db, hash, limits.maxSourceBytes);
                if (cached) reserve(Buffer.byteLength(JSON.stringify(cached)));
                return cached;
              },
            })(event),
          });
          // scanComplete describes fences only. No live reconciliation exists.
          console.log(JSON.stringify({ generation: values.generation, chatId, ...result, rssBytes: process.memoryUsage().rss }));
          if (result.scanComplete || abort.signal.aborted) break;
        }
        if (abort.signal.aborted) break;
      }
    } finally {
      store.close();
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    sqlite.close();
  }
};

await run().catch((error: unknown) => {
  process.stderr.write(`${inspect(error, { depth: 5 })}\n`);
  process.exitCode = 1;
});
