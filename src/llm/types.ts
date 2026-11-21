export type ProviderFormat = 'openai-chat' | 'responses' | 'anthropic-messages';

/**
 * What a model can do when the caller needs a specific tool to be called.
 *
 * - `none`: forcing is unavailable. The request omits `tool_choice` entirely and
 *   the caller must not rely on a forced call to rescue the turn.
 * - `reasoningDisabledOnly`: forcing works only with reasoning switched off, so
 *   it is reserved for the last-resort call that must produce a message.
 *   Ordinary calls keep their reasoning and never force a choice.
 * - `anyToolOnly`: `tool_choice` may ask for "any" call but cannot name one, so
 *   the offered tool list is narrowed to the single tool instead.
 * - `full`: `tool_choice` may name the tool directly.
 */
export type ForceToolChoiceSupport = 'none' | 'reasoningDisabledOnly' | 'anyToolOnly' | 'full';

export interface LlmEndpoint {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: ProviderFormat;
  maxImagesAllowed?: number;
  timeoutSec?: number;
  extraBody?: Record<string, unknown>;
  anthropicBetas?: string[];
  /** Defaults to `full`. */
  forceToolChoiceSupport?: ForceToolChoiceSupport;
  /**
   * How much reasoning the model should spend. Each transport renders this in
   * its own vocabulary; the level names are the providers' shared scale.
   */
  reasoningEffort?: string;
}
