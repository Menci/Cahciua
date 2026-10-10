import { expect, it } from 'vitest';

import { createWorkspaceBudget, defaultHistoryLimits } from './budget';

it('accounts encoded bytes directly, including normal multi-megabyte sources, without a guessed memory multiplier', () => {
  const budget = createWorkspaceBudget({ ...defaultHistoryLimits, maxWorkspaceBytes: 8 * 1024 * 1024 });
  budget.reserve(3 * 1024 * 1024);
  budget.reserve(5 * 1024 * 1024);
  expect(budget.encodedBytes).toBe(8 * 1024 * 1024);
  expect(() => budget.reserve(1)).toThrow('workspace exceeds encoded byte budget');
});
