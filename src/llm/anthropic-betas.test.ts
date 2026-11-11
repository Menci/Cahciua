import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@guiiai/logg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import { callLlm } from './call';

const directory = mkdtempSync(join(tmpdir(), 'anthropic-betas-'));
vi.stubEnv('CONFIG_PATH', join(directory, 'config.yaml'));
const { loadConfig, resolveModel } = await import('../config/config');

afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true });
});

const writeConfig = (models: Record<string, unknown>) => {
  writeFileSync(join(directory, 'config.yaml'), stringify({
    models,
    telegram: { botToken: 'test', apiId: 1, apiHash: 'test' },
    runtime: { writeFile: ['cat'], readFile: ['cat'] },
    chats: { default: { tools: {} }, '-100123': {} },
  }));
};

const response = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'test-model',
  content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

const logger = {
  withFields: vi.fn(),
  log: vi.fn(),
};
logger.withFields.mockReturnValue(logger);

const callModel = async (modelName: string) => {
  const model = resolveModel(loadConfig(), modelName);
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  await callLlm(model, [{
    kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'hello' }],
  }], 'system', undefined, { log: logger as unknown as Logger, label: 'beta-test' });
  expect(fetchMock).toHaveBeenCalledOnce();
  return fetchMock.mock.calls[0]!;
};

describe('per-model Anthropic beta headers', () => {
  it('sends configured beta names in one header through the common call boundary', async () => {
    writeConfig({
      configured: {
        apiBaseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'test-model',
        apiFormat: 'anthropic-messages', anthropicBetas: ['feature-a-2026-01-01', 'feature-b-2026-02-02'],
      },
    });
    const [url, init] = await callModel('configured');
    expect(url).toBe('https://example.test/v1/messages');
    expect(init?.headers).toMatchObject({
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'feature-a-2026-01-01,feature-b-2026-02-02',
    });
    expect(JSON.parse(init?.body as string)).not.toHaveProperty('anthropicBetas');
  });

  it('omits the beta header on another Anthropic model without the setting', async () => {
    writeConfig({
      plain: {
        apiBaseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'test-model',
        apiFormat: 'anthropic-messages',
      },
    });
    const [, init] = await callModel('plain');
    expect(init?.headers).not.toHaveProperty('anthropic-beta');
  });

  it.each(['openai-chat', 'responses', undefined])('rejects betas on %s models', format => {
    writeConfig({
      invalid: {
        apiBaseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'test-model',
        ...(format ? { apiFormat: format } : {}), anthropicBetas: ['feature-a-2026-01-01'],
      },
    });
    expect(() => loadConfig()).toThrow('anthropicBetas requires apiFormat="anthropic-messages"');
  });

  it('rejects empty beta identifiers in configuration', () => {
    writeConfig({
      invalid: {
        apiBaseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'test-model',
        apiFormat: 'anthropic-messages', anthropicBetas: [''],
      },
    });
    expect(() => loadConfig()).toThrow();
  });
});
