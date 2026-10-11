import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

const directory = mkdtempSync(join(tmpdir(), 'history-config-'));
const configPath = join(directory, 'config.yaml');
vi.stubEnv('CONFIG_PATH', configPath);
const { loadConfig } = await import('./config');
const { buildContainer } = await import('../container');
const { TOKENS } = await import('../container/tokens');
const { setupLogger } = await import('./logger');
setupLogger();
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true });
});
const fixture = (history?: unknown) => {
  writeFileSync(configPath, stringify({
    models: { primary: { apiBaseUrl: 'https://example.test', apiKey: 'test', model: 'test' } },
    telegram: { botToken: 'test', apiId: 1, apiHash: 'test' },
    runtime: { writeFile: ['cat'], readFile: ['cat'] },
    chats: { default: { tools: {} }, A: {} },
    ...(history === undefined ? {} : { history }),
  }));
  return loadConfig();
};

describe('global historical retrieval YAML switch', () => {
  it('defaults to disabled when omitted or empty', () => {
    expect(fixture().history.enabled).toBe(false);
    expect(fixture({}).history.enabled).toBe(false);
  });
  it('accepts explicit enabling and disabling', () => {
    expect(fixture({ enabled: true }).history.enabled).toBe(true);
    expect(fixture({ enabled: false }).history.enabled).toBe(false);
  });
  it('rejects a string toggle or a non-object history section', () => {
    expect(() => fixture({ enabled: 'true' })).toThrow();
    expect(() => fixture(true)).toThrow();
  });
  it('wires the disabled capability into the real container without resolving worker overrides or creating history.db', async () => {
    fixture();
    const historyPath = join(directory, 'must-not-exist.db');
    vi.stubEnv('CAHCIUA_HISTORY_PATH', historyPath);
    vi.stubEnv('CAHCIUA_HISTORY_LIMITS', 'not valid JSON');
    const container = buildContainer();
    const runtime = container.get(TOKENS.HISTORY_RUNTIME);
    try {
      expect(container.get(TOKENS.HISTORY_ACCESS).enabled).toBe(false);
      expect(container.get(TOKENS.HISTORY_ACCESS)).toBe(container.get(TOKENS.HISTORY_ACCESS));
      runtime.start();
      expect(runtime.metrics()).toMatchObject({ enabled: false, running: false });
      expect(existsSync(historyPath)).toBe(false);
    } finally {
      await runtime.stop();
      await container.dispose();
    }
  });
});
