import Database from 'better-sqlite3';

import { QueryError, checkBytes, resolveQueryLimits } from './budget';
import type { QueryLimits } from './budget';
import { runQueryCode } from './interpreter';
import { createQuerySdk } from './sdk';
import { openQuerySnapshot } from './snapshot';
import type { QueryScope } from './snapshot';

export interface QueryRequest extends QueryScope { code: string; limits?: Partial<QueryLimits> }
export type QueryResponse = { status: 'ok'; result: unknown; index: ReturnType<typeof openQuerySnapshot>['index'] } | { status: string; error: string };
export const executeSnapshotQuery = async (request: QueryRequest): Promise<QueryResponse> => {
  const limits = resolveQueryLimits(request.limits);
  checkBytes(request.code, limits.codeBytes, 'Code');
  const snapshot = openQuerySnapshot(request);
  try {
    const sdk = createQuerySdk(snapshot, limits);
    const result = await runQueryCode(request.code, sdk, limits);
    const response = { status: 'ok' as const, result, index: snapshot.index };
    checkBytes(JSON.stringify(response), limits.resultBytes, 'Final JSON with index status');
    return response;
  } finally { snapshot.close(); }
};
// Parent alone supplies scope, paths and policy over IPC. The model receives
// only four JSON bridges, never this process or a connection handle.
if (process.argv[2] === '--history-query-worker') {
  process.once('disconnect', () => process.exit(1));
  process.once('message', (request: QueryRequest) => {
    const execute = async () => {
      // SQLite's heap quota is process-global. Set it only inside the dedicated
      // child, never inside the reusable snapshot API or a builder process.
      const quota = new Database(':memory:');
      try {
        quota.pragma(`hard_heap_limit=${resolveQueryLimits(request.limits).memoryBytes}`);
        return await executeSnapshotQuery(request);
      } finally { quota.close(); }
    };
    void execute().then(response => {
      process.send?.(response, () => process.disconnect());
    }, (cause: unknown) => {
      const memoryFailure = cause instanceof Error && 'code' in cause && (cause.code === 'SQLITE_NOMEM' || cause.code === 'SQLITE_TOOBIG');
      const response = { status: cause instanceof QueryError ? cause.status : memoryFailure ? 'budget_exceeded' : 'query_failed', error: cause instanceof QueryError ? cause.message : memoryFailure ? 'Native SQLite memory budget exceeded' : 'History query failed' };
      process.send?.(response, () => process.disconnect());
    });
  });
}
