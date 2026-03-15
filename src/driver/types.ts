import type { FeatureFlags } from '../config/config';
import type { RenderedContentPiece } from '../rendering/types';

export type ProviderFormat = 'openai-chat' | 'responses';

// OpenAI Chat Completions format entries stored in TR data.
// No DB migration needed — these types describe the existing JSON shape.

export interface TRToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface TRAssistantEntry {
  role: 'assistant';
  content?: string | null | unknown[];
  tool_calls?: TRToolCall[];
  reasoning_text?: string;
  reasoning_opaque?: string;
}

export interface TRToolResultEntry {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export type TRDataEntry = TRAssistantEntry | TRToolResultEntry;

export interface TurnResponse {
  requestedAtMs: number;
  provider: ProviderFormat;
  data: unknown[];
  inputTokens: number;
  outputTokens: number;
  reasoningSignatureCompat?: string;
}

export interface LlmEndpoint {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ProviderFormat;
  reasoningSignatureCompat?: string;
  maxImagesAllowed?: number;
}

// ContextChunk — merge output intermediate representation
export type ContextChunk =
  | { type: 'rc'; time: number; step: -1; content: RenderedContentPiece[] }
  | { type: 'tr'; provider: ProviderFormat; time: number; step: number; data: unknown };

export interface DriverConfig {
  primaryModel: LlmEndpoint;
  chatIds: string[];
  featureFlags: FeatureFlags;
  compaction: CompactionConfig;
  probe: { enabled: boolean; model: LlmEndpoint };
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

export type { FeatureFlags } from '../config/config';
