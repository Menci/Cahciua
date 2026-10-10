import type { HistoryConfig } from '../config/config';

export class HistoryDisabledError extends Error {
  constructor() {
    super('Historical retrieval is disabled by history.enabled=false');
    this.name = 'HistoryDisabledError';
  }
}

// One process-wide capability for the independent history layer. Future query
// tools/APIs and their backends share it; worker overrides cannot enable it.
export const createHistoryAccess = ({ enabled }: HistoryConfig) => Object.freeze({
  enabled,
  run<T>(operation: () => T): T {
    if (!enabled) throw new HistoryDisabledError();
    return operation();
  },
});
export type HistoryAccess = ReturnType<typeof createHistoryAccess>;
