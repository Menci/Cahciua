export interface HistoryLimits {
  readonly maxSourceBytes: number;
  readonly maxStateEntries: number;
  readonly maxWorkspaceBytes: number;
  readonly maxOutputItems: number;
  readonly maxRowsPerSlice: number;
  readonly rowsPerSecond: number;
}
export const defaultHistoryLimits: HistoryLimits = {
  maxSourceBytes: 64 * 1024 * 1024,
  maxStateEntries: 256,
  maxWorkspaceBytes: 128 * 1024 * 1024,
  maxOutputItems: 4096,
  maxRowsPerSlice: 64,
  rowsPerSecond: 100,
};
export const checkHistoryLimits = (limits: HistoryLimits): void => {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`History ${name} must be a positive safe integer`);
  }
};
// Count encoded source/dependency/plan bytes directly. This is a content limit,
// not an estimate of V8/native memory; RSS is measured separately by the worker.
export const createWorkspaceBudget = (limits: HistoryLimits) => {
  let bytes = 0;
  let entries = 0;
  return {
    reserve(size: number): void {
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid history workspace reservation');
      bytes += size;
      if (bytes > limits.maxWorkspaceBytes) throw new Error(`History workspace exceeds encoded byte budget (${limits.maxWorkspaceBytes}); cursor unchanged`);
    },
    entry(): void {
      if (++entries > limits.maxStateEntries) throw new Error(`History dependencies exceed entry budget (${limits.maxStateEntries}); cursor unchanged`);
    },
    get encodedBytes() { return bytes; },
    get entries() { return entries; },
  };
};
export type WorkspaceBudget = ReturnType<typeof createWorkspaceBudget>;
