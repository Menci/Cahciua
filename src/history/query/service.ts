import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { HistoryAccess } from '../access';
import { checkBytes, QueryError, resolveQueryLimits } from './budget';
import type { QueryLimits } from './budget';
import type { QueryScope } from './snapshot';
import type { QueryRequest, QueryResponse } from './worker';

export const createHistoryQueryService = (deps: {
  access: HistoryAccess;
  scope: (chatId: string) => QueryScope | undefined;
  limits?: Partial<QueryLimits>;
  spawn?: (entry: string) => ChildProcess;
}) => {
  const limits = resolveQueryLimits(deps.limits);
  const tails = new Map<string, Promise<unknown>>();
  const active = new Map<ChildProcess, () => void>();
  let stopped = false;
  const execute = async (chatId: string, code: string): Promise<QueryResponse> => {
    if (stopped) return { status: 'cancelled', error: 'History query service stopped' };
    const scope = deps.scope(chatId);
    if (!scope) return { status: 'index_not_ready', error: 'History index has not started' };
    try { checkBytes(code, limits.codeBytes, 'Code'); } catch (error) {
      if (error instanceof QueryError) return { status: error.status, error: error.message };
      throw error;
    }
    const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './history-query-worker.mjs', import.meta.url));
    return await new Promise<QueryResponse>(resolve => {
      let response: QueryResponse | undefined;
      let child: ChildProcess;
      try { child = (deps.spawn ?? (path => fork(path, ['--history-query-worker'], { execArgv: [...process.execArgv, '--max-old-space-size=64'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })))(entry); } catch {
        resolve({ status: 'index_not_ready', error: 'Query process could not start' });
        return;
      }
      const terminate = (status: string, error: string) => { response = { status, error }; child.kill('SIGKILL'); };
      const timer = setTimeout(() => terminate('deadline_exceeded', 'Query deadline exceeded; snapshot released by process termination'), limits.deadlineMs);
      active.set(child, () => terminate('cancelled', 'History query cancelled'));
      child.on('message', (value: QueryResponse) => { response = value; });
      child.once('error', () => terminate('index_not_ready', 'Query process could not start'));
      // close follows both process exit and failed spawn; resolve only once
      // the child can no longer hold its snapshot or inherited streams.
      child.once('close', () => {
        clearTimeout(timer); active.delete(child);
        resolve(response ?? { status: 'query_failed', error: 'Query process exited without a result' });
      });
      const request: QueryRequest = { ...scope, code, limits };
      child.send(request, error => { if (error) terminate('query_failed', 'Query process IPC failed'); });
    });
  };
  return {
    executeQuery(chatId: string, code: string): Promise<QueryResponse> {
      return deps.access.run(() => {
        const previous = tails.get(chatId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(() => execute(chatId, code));
        tails.set(chatId, next);
        void next.finally(() => { if (tails.get(chatId) === next) tails.delete(chatId); }).catch(() => undefined);
        return next;
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const cancel of active.values()) cancel();
      await Promise.allSettled([...tails.values()]);
    },
    metrics: () => ({ active: active.size, queuedChats: tails.size, stopped }),
  };
};
export type HistoryQueryService = ReturnType<typeof createHistoryQueryService>;
