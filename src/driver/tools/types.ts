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
}
