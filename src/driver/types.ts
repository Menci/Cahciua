import type { FeatureFlags } from '../config/config';

export interface TurnResponse {
  requestedAtMs: number;
  provider: string;
  data: unknown[];
  sessionMeta?: unknown;
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
}

export type { FeatureFlags } from '../config/config';
