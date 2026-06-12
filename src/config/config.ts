import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { merge } from 'es-toolkit';
import * as v from 'valibot';
import { parse as parseYaml } from 'yaml';

import type { CompactionConfig, DebounceConfig, LlmEndpoint, ProviderFormat } from '../driver/types';
import type { WebFetchConfig } from '../driver/web-fetch/types';
import type { WebSearchConfig } from '../driver/web-search/types';

const llmEndpointEntries = {
  apiBaseUrl: v.string(),
  apiKey: v.string(),
  model: v.string(),
  apiFormat: v.optional(v.picklist(['openai-chat', 'responses', 'anthropic-messages'])),
  maxImagesAllowed: v.optional(v.number()),
  timeoutSec: v.optional(v.number()),
  thinking: v.optional(v.object({
    type: v.optional(v.picklist(['enabled', 'disabled'])),
    effort: v.optional(v.string()),
  })),
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
  primary: v.optional(v.object({
    model: v.optional(v.string(), 'primary'),
    forceToolCall: v.optional(v.boolean(), false),
  }), {}),
  systemFiles: v.optional(v.array(v.string()), []),
  sendTypingAction: v.optional(v.boolean(), true),
  debounce: v.optional(v.object({
    initialDelayMs: v.optional(v.number(), 1000),
    typingExtendMs: v.optional(v.number(), 5000),
    maxDelayMs: v.optional(v.number(), 30000),
  }), {}),
  compaction: v.optional(v.object({
    maxContextEstTokens: v.optional(v.number(), 200000),
    workingWindowEstTokens: v.optional(v.number(), 8000),
    model: v.optional(v.string()),
  }), {}),
  probe: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.string(), ''),
    forceToolCall: v.optional(v.boolean(), false),
  }), {}),
  imageToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.string(), ''),
    maxConcurrency: v.optional(v.number(), 3),
  }), {}),
  animationToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.string(), ''),
    maxFrames: v.optional(v.number(), 5),
    maxConcurrency: v.optional(v.number(), 3),
  }), {}),
  customEmojiToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.string(), ''),
    maxFrames: v.optional(v.number(), 5),
    maxConcurrency: v.optional(v.number(), 3),
  }), {}),
  tools: v.object({
    bash: v.optional(v.object({
      backgroundThresholdSec: v.optional(v.number(), 10),
    }), {}),
    web: v.optional(v.object({
      providers: v.optional(v.object({
        tavily: v.optional(v.object({ apiKey: v.optional(v.string(), '') }), {}),
        microsoftGrounding: v.optional(v.object({ apiKey: v.optional(v.string(), '') }), {}),
        jina: v.optional(v.object({ apiKey: v.optional(v.string(), '') }), {}),
        exa: v.optional(v.object({ apiKey: v.optional(v.string(), '') }), {}),
      }), {}),
      search: v.optional(v.picklist(['tavily', 'microsoft-grounding', 'jina', 'exa'])),
      fetch: v.optional(v.picklist(['jina'])),
    }), {}),
  }),
});

// Per-chat overrides: all fields optional, no defaults
const ChatOverrideSchema = v.optional(v.partial(v.object({
  primary: v.partial(v.object({
    model: v.string(),
    forceToolCall: v.boolean(),
  })),
  systemFiles: v.array(v.string()),
  sendTypingAction: v.boolean(),
  debounce: v.partial(v.object({
    initialDelayMs: v.number(),
    typingExtendMs: v.number(),
    maxDelayMs: v.number(),
  })),
  compaction: v.partial(v.object({
    maxContextEstTokens: v.number(),
    workingWindowEstTokens: v.number(),
    model: v.string(),
  })),
  probe: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
    forceToolCall: v.boolean(),
  })),
  imageToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
    maxConcurrency: v.number(),
  })),
  animationToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
    maxFrames: v.number(),
    maxConcurrency: v.number(),
  })),
  customEmojiToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
    maxFrames: v.number(),
    maxConcurrency: v.number(),
  })),
  tools: v.partial(v.object({
    bash: v.partial(v.object({
      backgroundThresholdSec: v.number(),
    })),
    web: v.partial(v.object({
      providers: v.partial(v.object({
        tavily: v.partial(v.object({ apiKey: v.string() })),
        microsoftGrounding: v.partial(v.object({ apiKey: v.string() })),
        jina: v.partial(v.object({ apiKey: v.string() })),
        exa: v.partial(v.object({ apiKey: v.string() })),
      })),
      search: v.picklist(['tavily', 'microsoft-grounding', 'jina', 'exa']),
      fetch: v.picklist(['jina']),
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
    apiId: v.number(),
    apiHash: v.string(),
    /** Whether to enable userbot. Requires running `pnpm login` once to populate the tdlib state dir. */
    userbotEnabled: v.optional(v.boolean(), false),
    /** Override the default tdlib state directory for the bot client (defaults to data/tdlib-bot). */
    botDataDir: v.optional(v.string()),
    /** Override the default tdlib state directory for the userbot client (defaults to data/tdlib-userbot). */
    userbotDataDir: v.optional(v.string()),
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
  primary: { model: LlmEndpoint; apiFormat: ProviderFormat; forceToolCall: boolean };
  systemFiles: { filename: string; content: string }[];
  sendTypingAction: boolean;
  debounce: DebounceConfig;
  compaction: CompactionConfig;
  probe: { enabled: boolean; model: LlmEndpoint; forceToolCall: boolean };
  imageToText: { enabled: boolean; model?: string; maxConcurrency: number };
  animationToText: { enabled: boolean; model?: string; maxFrames: number; maxConcurrency: number };
  customEmojiToText: { enabled: boolean; model?: string; maxFrames: number; maxConcurrency: number };
  tools: {
    bash: { backgroundThresholdSec: number };
    webSearch?: WebSearchConfig;
    webFetch?: WebFetchConfig;
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

  const primaryModel = resolveModel(config, merged.primary.model);
  const primaryApiFormat: ProviderFormat = primaryModel.apiFormat ?? 'openai-chat';

  const web = merged.tools.web;
  const providers = web.providers;

  let webSearch: WebSearchConfig | undefined;
  if (web.search) {
    const apiKey = web.search === 'tavily' ? providers.tavily.apiKey
      : web.search === 'microsoft-grounding' ? providers.microsoftGrounding.apiKey
        : web.search === 'jina' ? providers.jina.apiKey
          : providers.exa.apiKey;
    const providerKey = web.search === 'microsoft-grounding' ? 'microsoftGrounding' : web.search;
    if (!apiKey)
      throw new Error(`Chat ${chatId}: tools.web.providers.${providerKey}.apiKey is required for web.search="${web.search}".`);
    webSearch = { provider: web.search, apiKey };
  }

  let webFetch: WebFetchConfig | undefined;
  if (web.fetch === 'jina') {
    // Jina fetch's apiKey is optional (anonymous tier works); empty string passes through.
    webFetch = { provider: 'jina', jina: { apiKey: providers.jina.apiKey } };
  }

  return {
    primary: { model: primaryModel, apiFormat: primaryApiFormat, forceToolCall: merged.primary.forceToolCall },
    systemFiles: merged.systemFiles.map(path => ({
      filename: basename(path),
      content: readFileSync(path, 'utf-8').trim(),
    })),
    debounce: merged.debounce,
    sendTypingAction: merged.sendTypingAction,
    compaction: {
      ...merged.compaction,
      model: merged.compaction.model ? resolveModel(config, merged.compaction.model) : undefined,
    },
    probe: {
      enabled: merged.probe.enabled,
      model: merged.probe.model ? resolveModel(config, merged.probe.model) : primaryModel,
      forceToolCall: merged.probe.forceToolCall,
    },
    imageToText: {
      enabled: merged.imageToText.enabled,
      model: merged.imageToText.model || undefined,
      maxConcurrency: merged.imageToText.maxConcurrency,
    },
    animationToText: {
      enabled: merged.animationToText.enabled,
      model: merged.animationToText.model || undefined,
      maxFrames: merged.animationToText.maxFrames,
      maxConcurrency: merged.animationToText.maxConcurrency,
    },
    customEmojiToText: {
      enabled: merged.customEmojiToText.enabled,
      model: merged.customEmojiToText.model || undefined,
      maxFrames: merged.customEmojiToText.maxFrames,
      maxConcurrency: merged.customEmojiToText.maxConcurrency,
    },
    tools: {
      bash: { backgroundThresholdSec: merged.tools.bash.backgroundThresholdSec },
      ...(webSearch ? { webSearch } : {}),
      ...(webFetch ? { webFetch } : {}),
    },
  };
};
