import type { ResponseFunctionCallOutputItem, ResponseOutputItem } from './responses-types';
import type { ResolvedChatConfig } from '../config/config';
import type { RenderedContentPiece } from '../rendering/types';

export type ProviderFormat = 'openai-chat' | 'responses';

// OpenAI Chat Completions format entries stored in TR data.
// No DB migration needed — these types describe the existing JSON shape.

export interface TRToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ExtendedMessagePart {
  type: string;
  text?: string;
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
  source?: unknown;
  [key: string]: unknown;
}

export interface ExtendedMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: string | null | ExtendedMessagePart[];
  tool_calls?: TRToolCall[];
  tool_call_id?: string;
  reasoning_text?: string;
  reasoning_opaque?: string;
  reasoning_content?: string;
  reasoning?: string;
}

export interface TRAssistantEntry {
  role: 'assistant';
  content?: string | null | ExtendedMessagePart[];
  tool_calls?: TRToolCall[];
  reasoning_text?: string;
  reasoning_opaque?: string;
  reasoning_content?: string;
  reasoning?: string;
}

export interface TRToolResultEntry {
  role: 'tool';
  tool_call_id: string;
  content: string;
  requiresFollowUp?: boolean;
}

export type TRDataEntry = TRAssistantEntry | TRToolResultEntry;
export type ResponsesTRDataItem = ResponseOutputItem | ResponseFunctionCallOutputItem;

interface BaseTurnResponse {
  requestedAtMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningSignatureCompat?: string;
}

export interface ChatTurnResponse extends BaseTurnResponse {
  provider: 'openai-chat';
  data: TRDataEntry[];
}

export interface ResponsesTurnResponse extends BaseTurnResponse {
  provider: 'responses';
  data: ResponsesTRDataItem[];
}

export type TurnResponse = ChatTurnResponse | ResponsesTurnResponse;

export interface LlmEndpoint {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ProviderFormat;
  reasoningSignatureCompat?: string;
  maxImagesAllowed?: number;
  timeoutSec?: number;
}

// ContextChunk — merge output intermediate representation
export type ContextChunk =
  | { type: 'rc'; time: number; step: -1; content: RenderedContentPiece[] }
  | { type: 'tr'; provider: 'openai-chat'; time: number; step: number; data: TRDataEntry }
  | { type: 'tr'; provider: 'responses'; time: number; step: number; data: ResponsesTRDataItem };

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
