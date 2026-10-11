import { createHash } from 'node:crypto';

import type { HistoryWorkerOptions } from './worker';

export const historyRenderIdentity = (options: HistoryWorkerOptions): string => createHash('sha256').update(JSON.stringify(options.renderParams ?? {})).digest('hex');
export const historyGeneration = (options: HistoryWorkerOptions): string => options.generation ?? `incremental-v3-${historyRenderIdentity(options).slice(0, 16)}`;
