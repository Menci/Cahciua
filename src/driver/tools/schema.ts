import type { CahciuaTool } from './types';
import type { ToolSchema } from '../../llm/call';

export const toToolSchema = (tool: CahciuaTool): ToolSchema => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
});
