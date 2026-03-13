export interface TurnResponse {
  requestedAtMs: number;
  provider: string;
  data: unknown[];
  sessionMeta?: unknown;
  inputTokens: number;
  outputTokens: number;
  reasoningCompat?: string;
}

export interface DriverConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  maxContextTokens: number;
  chatIds: string[];
  reasoningSignatureCompat?: string;
}
