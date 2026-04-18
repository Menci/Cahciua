import type { ResolvedChatConfig } from '../config/config';
import type { ConversationEntry } from '../unified-api/types';

export type ProviderFormat = 'openai-chat' | 'responses' | 'anthropic-messages';

export interface TurnResponseV2 {
  requestedAtMs: number;
  entries: ConversationEntry[];
  inputTokens: number;
  outputTokens: number;
  modelName: string;
}

export interface ProbeResponseV2 {
  requestedAtMs: number;
  entries: ConversationEntry[];
  inputTokens: number;
  outputTokens: number;
  modelName: string;
  isActivated: boolean;
  createdAt: number;
}

export interface LlmEndpoint {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ProviderFormat;
  maxImagesAllowed?: number;
  timeoutSec?: number;
}

export interface DriverConfig {
  chatIds: string[];
  resolveChatConfig: (chatId: string) => ResolvedChatConfig;
}

export interface CompactionConfig {
  enabled: boolean;
  maxContextEstTokens: number;
  workingWindowEstTokens: number;
  model?: LlmEndpoint;
  dryRun?: boolean;
}

export interface CompactionSessionMeta {
  oldCursorMs: number;
  newCursorMs: number;
  summary: string;
  inputTokens: number;
  outputTokens: number;
}

export type { FeatureFlags, ResolvedChatConfig } from '../config/config';
