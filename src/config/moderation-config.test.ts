import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

const directory = mkdtempSync(join(tmpdir(), 'moderation-config-'));
const configPath = join(directory, 'config.yaml');
const identityPath = join(directory, 'IDENTITY.md');
const policyPath = join(directory, 'group-policy.md');
writeFileSync(identityPath, 'Shared identity');
writeFileSync(policyPath, 'Group-only moderation policy');
vi.stubEnv('CONFIG_PATH', configPath);
const { loadConfig, resolveChatConfig } = await import('./config');

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true });
});

const fixture = (overrides: Record<string, unknown>) => {
  writeFileSync(configPath, stringify({
    models: { primary: { apiBaseUrl: 'https://example.test', apiKey: 'test', model: 'test' } },
    telegram: { botToken: 'test', apiId: 1, apiHash: 'test' },
    runtime: { writeFile: ['cat'], readFile: ['cat'] },
    chats: {
      default: { systemFiles: [identityPath], tools: {} },
      '-100123': {},
      '-100456': {},
      ...overrides,
    },
  }));
  return loadConfig();
};

describe('per-chat moderation configuration', () => {
  it('defaults to disabled and enables only the chosen group with its identity and policy', () => {
    const config = fixture({
      '-100123': { tools: { banSpammer: true }, systemFiles: [identityPath, policyPath] },
    });
    const enabled = resolveChatConfig(config, '-100123');
    const disabled = resolveChatConfig(config, '-100456');
    expect(enabled.tools.banSpammer).toBe(true);
    expect(enabled.systemFiles.map(file => file.content)).toEqual(['Shared identity', 'Group-only moderation policy']);
    expect(disabled.tools.banSpammer).toBe(false);
    expect(disabled.systemFiles.map(file => file.content)).toEqual(['Shared identity']);
  });

  it('allows a chat to explicitly disable an inherited capability', () => {
    const config = fixture({
      default: { tools: { banSpammer: true } },
      '-100123': { tools: { banSpammer: false } },
    });
    expect(resolveChatConfig(config, '-100123').tools.banSpammer).toBe(false);
    expect(resolveChatConfig(config, '-100456').tools.banSpammer).toBe(true);
  });

  it('rejects non-boolean capability settings', () => {
    expect(() => fixture({ '-100123': { tools: { banSpammer: 'true' } } })).toThrow();
  });
});
