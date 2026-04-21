import { readFileSync } from 'node:fs';

import { merge } from 'es-toolkit';
import * as v from 'valibot';
import { parse as parseYaml } from 'yaml';

import type { CompactionConfig, LlmEndpoint, ProviderFormat } from '../driver/types';

const llmEndpointEntries = {
  apiBaseUrl: v.string(),
  apiKey: v.string(),
  model: v.string(),
  apiFormat: v.optional(v.picklist(['openai-chat', 'responses', 'anthropic-messages'])),
  maxImagesAllowed: v.optional(v.number()),
  timeoutSec: v.optional(v.number()),
};

// --- Runtime config schema (top-level, global) ---

const DEFAULT_FILE_SIZE_LIMIT = 20 * 1024 * 1024; // 20 MB

const RuntimeSchema = v.object({
  shell: v.optional(v.array(v.string()), ['/bin/bash', '-c']),
  writeFile: v.array(v.string()),
  readFile: v.array(v.string()),
  writeFileSizeLimit: v.optional(v.number(), DEFAULT_FILE_SIZE_LIMIT),
  readFileSizeLimit: v.optional(v.number(), DEFAULT_FILE_SIZE_LIMIT),
});

// --- Chat-level config schemas ---

const ChatConfigSchema = v.object({
  model: v.optional(v.string(), 'primary'),
  compaction: v.optional(v.object({
    maxContextEstTokens: v.optional(v.number(), 200000),
    workingWindowEstTokens: v.optional(v.number(), 8000),
    model: v.optional(v.string()),
  }), {}),
  probe: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.string(), ''),
  }), {}),
  imageToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.string(), ''),
  }), {}),
  animationToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.string(), ''),
    maxFrames: v.optional(v.number(), 5),
  }), {}),
  customEmojiToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.string(), ''),
    maxFrames: v.optional(v.number(), 5),
  }), {}),
  tools: v.object({
    bash: v.optional(v.object({
      backgroundThresholdSec: v.optional(v.number(), 10),
    }), {}),
    webSearch: v.object({
      tavilyKey: v.pipe(v.string(), v.minLength(1)),
    }),
  }),
});

// Per-chat overrides: all fields optional, no defaults
const ChatOverrideSchema = v.optional(v.partial(v.object({
  model: v.string(),
  compaction: v.partial(v.object({
    maxContextEstTokens: v.number(),
    workingWindowEstTokens: v.number(),
    model: v.string(),
  })),
  probe: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
  })),
  imageToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
  })),
  animationToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
    maxFrames: v.number(),
  })),
  customEmojiToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
    maxFrames: v.number(),
  })),
  tools: v.partial(v.object({
    bash: v.partial(v.object({
      backgroundThresholdSec: v.number(),
    })),
    webSearch: v.partial(v.object({
      tavilyKey: v.string(),
    })),
  })),
})), {});

const BackgroundTasksSchema = v.optional(v.object({
  outputDir: v.optional(v.string(), './data/task-outputs'),
  retentionCount: v.optional(v.number(), 20),
}), {});

const ConfigSchema = v.object({
  models: v.record(v.string(), v.object(llmEndpointEntries)),
  telegram: v.object({
    botToken: v.string(),
    apiId: v.optional(v.number()),
    apiHash: v.optional(v.string()),
    session: v.optional(v.string(), ''),
  }),
  database: v.optional(v.object({
    path: v.optional(v.string(), './data/cahciua.db'),
  }), {}),
  runtime: RuntimeSchema,
  backgroundTasks: BackgroundTasksSchema,
  chats: v.objectWithRest({ default: ChatConfigSchema }, ChatOverrideSchema),
});

export type Config = v.InferOutput<typeof ConfigSchema>;
export type ChatConfig = v.InferOutput<typeof ChatConfigSchema>;

export interface RuntimeConfig {
  shell: string[];
  writeFile: string[];
  readFile: string[];
  writeFileSizeLimit: number;
  readFileSizeLimit: number;
}

export interface BackgroundTasksConfig {
  outputDir: string;
  retentionCount: number;
}

export interface ResolvedChatConfig {
  primaryModel: LlmEndpoint;
  primaryApiFormat: ProviderFormat;
  compaction: CompactionConfig;
  probe: { enabled: boolean; model: LlmEndpoint };
  imageToText: { enabled: boolean; model?: string };
  animationToText: { enabled: boolean; model?: string; maxFrames: number };
  customEmojiToText: { enabled: boolean; model?: string; maxFrames: number };
  tools: {
    bash: { backgroundThresholdSec: number };
    webSearch: { tavilyKey: string };
  };
}

const CONFIG_PATH = process.env.CONFIG_PATH ?? 'config.yaml';

export const loadConfig = (): Config => {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = parseYaml(raw);
  return v.parse(ConfigSchema, parsed);
};

export const resolveRuntime = (config: Config): RuntimeConfig => ({
  shell: config.runtime.shell,
  writeFile: config.runtime.writeFile,
  readFile: config.runtime.readFile,
  writeFileSizeLimit: config.runtime.writeFileSizeLimit,
  readFileSizeLimit: config.runtime.readFileSizeLimit,
});

export const resolveBackgroundTasks = (config: Config): BackgroundTasksConfig => ({
  outputDir: config.backgroundTasks.outputDir,
  retentionCount: config.backgroundTasks.retentionCount,
});

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
    animationToText: {
      enabled: merged.animationToText.enabled,
      model: merged.animationToText.model || undefined,
      maxFrames: merged.animationToText.maxFrames,
    },
    customEmojiToText: {
      enabled: merged.customEmojiToText.enabled,
      model: merged.customEmojiToText.model || undefined,
      maxFrames: merged.customEmojiToText.maxFrames,
    },
    tools: {
      bash: { backgroundThresholdSec: merged.tools.bash.backgroundThresholdSec },
      webSearch: { tavilyKey: merged.tools.webSearch.tavilyKey },
    },
  };
};
