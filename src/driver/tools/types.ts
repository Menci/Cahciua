import type { InputPart } from '../../unified-api/types';

export interface ToolResult {
  content: string | InputPart[];
  requiresFollowUp: boolean;
}

export interface CahciuaTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  validate: (input: unknown) => { valid: boolean; errors: string[] };
  execute: (input: unknown) => Promise<ToolResult> | ToolResult;
  /**
   * Replaces the thrown error text in the result the model sees. Use it when the
   * raw failure can carry material the model must not repeat — moderation
   * failures, for instance, are reported without the account's identities.
   * The error is still logged in full.
   */
  failureMessage?: string;
}
