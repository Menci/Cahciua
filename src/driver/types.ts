import type { FeatureFlags } from '../config/config';

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
  provider: string;
  data: TRDataEntry[];
  inputTokens: number;
  outputTokens: number;
  reasoningSignatureCompat?: string;
}

export interface LlmEndpoint {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  reasoningSignatureCompat?: string;
  maxImagesAllowed?: number;
}

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
