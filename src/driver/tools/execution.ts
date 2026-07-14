import type { Logger } from '@guiiai/logg';

import type { CahciuaTool } from './types';
import type { ConversationEntry, ToolCallPart, ToolResult as IRToolResult } from '../../unified-api/types';

export const extractToolCalls = (entries: ConversationEntry[]): ToolCallPart[] => {
  const calls: ToolCallPart[] = [];
  for (const entry of entries) {
    if (entry.kind === 'message' && entry.role === 'assistant') {
      for (const part of entry.parts) {
        if (part.kind === 'toolCall') calls.push(part);
      }
    }
  }
  return calls;
};

const toolError = (id: string, message: string): IRToolResult => ({
  kind: 'toolResult',
  callId: id,
  payload: JSON.stringify({ error: message }),
  requiresFollowUp: true,
});

export const executeToolCall = async (
  id: string,
  name: string,
  args: string,
  tools: CahciuaTool[],
  log: Logger,
): Promise<IRToolResult> => {
  const tool = tools.find(candidate => candidate.name === name);
  if (!tool) return toolError(id, `Unknown tool: ${name}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    log.withFields({ tool: name, args }).error('Tool call has invalid JSON args');
    return toolError(id, `Invalid JSON in tool arguments: ${args.slice(0, 200)}`);
  }

  const { valid, errors } = tool.validate(parsed);
  if (!valid) {
    log.withFields({ tool: name, errors }).error('Tool call args failed schema validation');
    return toolError(id, `Arguments do not match schema: ${errors.join('; ')}`);
  }

  try {
    const { content, requiresFollowUp } = await tool.execute(parsed);
    return {
      kind: 'toolResult',
      callId: id,
      payload: content,
      requiresFollowUp,
    };
  } catch (error) {
    log.withError(error).error(`Tool ${name} failed`);
    return toolError(id, String(error));
  }
};
