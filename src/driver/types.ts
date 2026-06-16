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

export interface LlmEndpoint {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ProviderFormat;
  maxImagesAllowed?: number;
  timeoutSec?: number;
  /** Extra fields shallow-merged into the request body. The endpoint's apiFormat
   * decides whether this is OpenAI Chat (`reasoning_effort`, `temperature`, ...),
   * Anthropic Messages (`thinking`, `max_tokens`, ...), or OpenAI Responses
   * (`reasoning`, `text`, ...). Caller is responsible for not stomping on
   * structural fields we set (model, messages, tools, etc.). */
  extraBody?: Record<string, unknown>;
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

export interface DebounceConfig {
  initialDelayMs: number;
  typingExtendMs: number;
  maxDelayMs: number;
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
