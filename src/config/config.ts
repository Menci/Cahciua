import { readFileSync } from 'node:fs';

import { merge } from 'es-toolkit';
import * as v from 'valibot';
import { parse as parseYaml } from 'yaml';

import type { CompactionConfig, LlmEndpoint, ProviderFormat } from '../driver/types';

const llmEndpointEntries = {
  apiBaseUrl: v.string(),
  apiKey: v.string(),
  model: v.string(),
  apiFormat: v.optional(v.picklist(['openai-chat', 'responses'])),
  reasoningSignatureCompat: v.optional(v.string()),
  maxImagesAllowed: v.optional(v.number()),
  timeoutSec: v.optional(v.number()),
};

// --- Chat-level config schemas ---

const ChatConfigSchema = v.object({
  model: v.optional(v.string(), 'primary'),
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
  imageToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.string(), ''),
  }), {}),
  features: v.optional(v.object({
    trimStaleNoToolCallTurnResponses: v.optional(v.boolean(), false),
    trimSelfMessagesCoveredBySendToolCalls: v.optional(v.boolean(), false),
    trimToolResults: v.optional(v.boolean(), false),
  }), {}),
});

// Per-chat overrides: all fields optional, no defaults
const ChatOverrideSchema = v.optional(v.partial(v.object({
  model: v.string(),
  compaction: v.partial(v.object({
    enabled: v.boolean(),
    maxContextEstTokens: v.number(),
    workingWindowEstTokens: v.number(),
    model: v.string(),
    dryRun: v.boolean(),
  })),
  probe: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
  })),
  imageToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
  })),
  features: v.partial(v.object({
    trimStaleNoToolCallTurnResponses: v.boolean(),
    trimSelfMessagesCoveredBySendToolCalls: v.boolean(),
    trimToolResults: v.boolean(),
  })),
})), {});

const ConfigSchema = v.object({
  models: v.record(v.string(), v.object(llmEndpointEntries)),
  telegram: v.object({
    botToken: v.string(),
    apiId: v.number(),
    apiHash: v.string(),
    session: v.optional(v.string(), ''),
  }),
  database: v.optional(v.object({
    path: v.optional(v.string(), './data/cahciua.db'),
  }), {}),
  chats: v.objectWithRest({ default: ChatConfigSchema }, ChatOverrideSchema),
});

export type Config = v.InferOutput<typeof ConfigSchema>;
export type ChatConfig = v.InferOutput<typeof ChatConfigSchema>;
export type FeatureFlags = ChatConfig['features'];

export interface ResolvedChatConfig {
  primaryModel: LlmEndpoint;
  primaryApiFormat: ProviderFormat;
  compaction: CompactionConfig;
  probe: { enabled: boolean; model: LlmEndpoint };
  imageToText: { enabled: boolean; model?: string };
  featureFlags: FeatureFlags;
}

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

/** Return whitelisted chat IDs (all keys in chats except "default"). */
export const getChatIds = (config: Config): string[] =>
  Object.keys(config.chats).filter(k => k !== 'default');

/** Deep-merge default chat config with per-chat overrides and resolve model names. */
export const resolveChatConfig = (config: Config, chatId: string): ResolvedChatConfig => {
  const override = config.chats[chatId] ?? {};
  const merged: ChatConfig = merge(structuredClone(config.chats.default), override);

  const primaryModel = resolveModel(config, merged.model);
  const primaryApiFormat: ProviderFormat = primaryModel.apiFormat ?? 'openai-chat';

  return {
    primaryModel,
    primaryApiFormat,
    compaction: {
      ...merged.compaction,
      model: merged.compaction.model ? resolveModel(config, merged.compaction.model) : undefined,
    },
    probe: {
      enabled: merged.probe.enabled,
      model: merged.probe.model ? resolveModel(config, merged.probe.model) : primaryModel,
    },
    imageToText: {
      enabled: merged.imageToText.enabled,
      model: merged.imageToText.model || undefined,
    },
    featureFlags: merged.features,
  };
};
