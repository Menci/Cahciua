export interface QueryLimits {
  codeBytes: number;
  sqlBytes: number;
  deadlineMs: number;
  memoryBytes: number;
  calls: number;
  sqlRows: number;
  pageSize: number;
  neighbors: number;
  sdkBytes: number;
  resultBytes: number;
}
export const defaultQueryLimits: QueryLimits = {
  codeBytes: 16 * 1024, sqlBytes: 16 * 1024, deadlineMs: 10_000,
  memoryBytes: 32 * 1024 * 1024, calls: 30, sqlRows: 1000,
  pageSize: 50, neighbors: 20, sdkBytes: 128 * 1024, resultBytes: 24 * 1024,
};
export class QueryError extends Error {
  constructor(readonly status: string, message: string) { super(message); this.name = 'QueryError'; }
}
export const fail = (status: string, message: string): never => { throw new QueryError(status, message); };
export const checkBytes = (value: string, limit: number, label: string): void => {
  if (Buffer.byteLength(value) > limit) fail('budget_exceeded', `${label} exceeds ${limit} UTF-8 bytes`);
};
export const resolveQueryLimits = (limits: Partial<QueryLimits> = {}): QueryLimits => {
  const result = { ...defaultQueryLimits, ...limits };
  for (const [key, value] of Object.entries(result))
    if (!Number.isSafeInteger(value) || value < 1) fail('invalid_options', `${key} must be a positive safe integer`);
  return result;
};
export const createQueryBudget = (limits: QueryLimits) => {
  let calls = 0;
  let bytes = 0;
  // A caught SDK error cannot turn an over-budget script into a successful query.
  let failure: QueryError | undefined;
  return {
    call(): void {
      if (failure) throw failure;
      if (++calls > limits.calls) { failure = new QueryError('budget_exceeded', 'SDK call budget exceeded'); throw failure; }
    },
    charge<T>(value: T): T {
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (bytes > limits.sdkBytes) { failure = new QueryError('budget_exceeded', 'Cumulative SDK byte budget exceeded'); throw failure; }
      return value;
    },
    assert(): void { if (failure) throw failure; },
    record(error: unknown): void {
      if (error instanceof QueryError && error.status === 'budget_exceeded') failure ??= error;
    },
    metrics: () => ({ calls, sdkBytes: bytes }),
  };
};
