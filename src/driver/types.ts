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

export interface DriverConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  maxContextTokens: number;
  chatIds: string[];
  reasoningSignatureCompat?: string;
  featureFlags: FeatureFlags;
  compaction: CompactionConfig;
}

export interface CompactionConfig {
  enabled: boolean;
  workingWindowTokens: number;
  compactModel?: string;
  dryRun?: boolean;
}

export interface CompactionSessionMeta {
  oldCursorMs: number;
  newCursorMs: number;
  summary: string;
}

export type { FeatureFlags } from '../config/config';
