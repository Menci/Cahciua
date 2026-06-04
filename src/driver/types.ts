import type { ResolvedChatConfig } from '../config/config';
import type { ConversationEntry } from '../unified-api/types';

export type ProviderFormat = 'openai-chat' | 'responses' | 'anthropic-messages';

export interface TurnResponseV2 {
  requestedAtMs: number;
  entries: ConversationEntry[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelName: string;
}

export interface ProbeResponseV2 {
  requestedAtMs: number;
  entries: ConversationEntry[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelName: string;
  isActivated: boolean;
  createdAt: number;
}

export interface ThinkingConfig {
  type?: 'enabled' | 'disabled';
  effort?: 'high' | 'max';
}

export interface LlmEndpoint {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ProviderFormat;
  maxImagesAllowed?: number;
  timeoutSec?: number;
  thinking?: ThinkingConfig;
  forceToolCall?: boolean;
}

export interface DriverConfig {
  chatIds: string[];
  resolveChatConfig: (chatId: string) => ResolvedChatConfig;
}

export interface CompactionConfig {
  maxContextEstTokens: number;
  workingWindowEstTokens: number;
  model?: LlmEndpoint;
}

export interface CompactionSessionMeta {
  oldCursorMs: number;
  newCursorMs: number;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type { ResolvedChatConfig } from '../config/config';
