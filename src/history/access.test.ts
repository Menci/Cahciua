import { describe, expect, it, vi } from 'vitest';

import { createHistoryAccess, HistoryDisabledError } from './access';

describe('global historical retrieval capability', () => {
  it('rejects backend access before running a callback when disabled', () => {
    const access = createHistoryAccess({ enabled: false });
    const read = vi.fn(() => 'private history');
    expect(() => access.run(read)).toThrow(HistoryDisabledError);
    expect(read).not.toHaveBeenCalled();
  });

  it('captures the startup switch and preserves enabled sync/async results and failures', async () => {
    const config = { enabled: true };
    const access = createHistoryAccess(config);
    config.enabled = false;
    expect(access.enabled).toBe(true);
    expect(access.run(() => 'history')).toBe('history');
    await expect(access.run(async () => 'history')).resolves.toBe('history');
    const failure = new Error('source failure');
    expect(() => access.run(() => { throw failure; })).toThrow(failure);
  });
});
