import { createTool } from './create-tool';
import type { CahciuaTool } from './types';

export const createReadTaskOutputTool = (
  read: (taskId: number, offset?: number, limit?: number) => Promise<{ content: string; totalLines: number; truncated: boolean } | { error: string }>,
): CahciuaTool => createTool({
  name: 'read_task_output',
  description:
    'Read the full output of a completed background task. Supports pagination for large outputs. '
    + 'Use offset and limit to read specific ranges (line-based).',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number', description: 'The background task ID.' },
      offset: { type: 'number', description: 'Starting line number (0-based). Default: 0.' },
      limit: { type: 'number', description: 'Number of lines to read. Default: 200.' },
    },
    required: ['task_id'],
  },
  execute: async input => {
    const { task_id, offset, limit } = input as { task_id: number; offset?: number; limit?: number };
    const result = await read(task_id, offset, limit);
    return { content: JSON.stringify(result), requiresFollowUp: true };
  },
});
