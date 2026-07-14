export type ProviderFormat = 'openai-chat' | 'responses' | 'anthropic-messages';

export interface LlmEndpoint {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: ProviderFormat;
  maxImagesAllowed?: number;
  timeoutSec?: number;
  extraBody?: Record<string, unknown>;
}
