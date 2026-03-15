import { readFileSync } from 'node:fs';

import * as v from 'valibot';
import { parse as parseYaml } from 'yaml';

import type { LlmEndpoint } from '../driver/types';

const llmEndpointEntries = {
  apiBaseUrl: v.string(),
  apiKey: v.string(),
  model: v.string(),
  reasoningSignatureCompat: v.optional(v.string()),
  maxImagesAllowed: v.optional(v.number()),
};

const ConfigSchema = v.object({
  models: v.record(v.string(), v.object(llmEndpointEntries)),
  telegram: v.object({
    botToken: v.string(),
    apiId: v.number(),
    apiHash: v.string(),
    session: v.optional(v.string(), ''),
  }),
  llm: v.object({
    model: v.string(),
  }),
  driver: v.object({
    chatIds: v.array(v.string()),
  }),
  database: v.optional(v.object({
    path: v.optional(v.string(), './data/cahciua.db'),
  }), {}),
  compaction: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    maxContextEstTokens: v.optional(v.number(), 200000),
    workingWindowEstTokens: v.optional(v.number(), 8000),
    model: v.optional(v.string()),
    dryRun: v.optional(v.boolean(), false),
  }), {}),
  probe: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.string(), ''),
  }), {}),
  features: v.optional(v.object({
    trimStaleNoToolCallTurnResponses: v.optional(v.boolean(), false),
    trimSelfMessagesCoveredBySendToolCalls: v.optional(v.boolean(), false),
    trimToolResults: v.optional(v.boolean(), false),
  }), {}),
});

export type Config = v.InferOutput<typeof ConfigSchema>;
export type FeatureFlags = Config['features'];

const CONFIG_PATH = process.env.CONFIG_PATH ?? 'config.yaml';

export const loadConfig = (): Config => {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = parseYaml(raw);
  return v.parse(ConfigSchema, parsed);
};

export const resolveModel = (config: Config, name: string): LlmEndpoint => {
  const entry = config.models[name];
  if (!entry) throw new Error(`Unknown model "${name}" — not found in models registry`);
  return entry;
};
