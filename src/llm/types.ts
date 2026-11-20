export type ProviderFormat = 'openai-chat' | 'responses' | 'anthropic-messages';

/**
 * How to ask a provider for one specific tool when the caller forces a choice.
 *
 * - `specified` names the tool in `tool_choice` and ships every tool schema.
 * - `filtered` narrows the request to that one tool and asks for "any" call.
 *
 * Some providers reject a named `tool_choice`, or handle it less reliably than
 * a single-tool constraint, so the wire shape has to be selectable per model.
 */
export type ForcedToolChoiceMode = 'specified' | 'filtered';

export interface LlmEndpoint {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: ProviderFormat;
  maxImagesAllowed?: number;
  timeoutSec?: number;
  extraBody?: Record<string, unknown>;
  anthropicBetas?: string[];
  forcedToolChoiceMode?: ForcedToolChoiceMode;
}
