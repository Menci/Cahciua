import { createTool } from './create-tool';
import type { CahciuaTool } from './types';

export const createKillTaskTool = (
  kill: (taskId: number) => { ok: boolean; error?: string },
): CahciuaTool => createTool({
  name: 'kill_task',
  description: 'Kill a running background task by its ID.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number', description: 'The background task ID to kill.' },
    },
    required: ['task_id'],
  },
  execute: input => {
    const { task_id } = input as { task_id: number };
    const result = kill(task_id);
    return { content: JSON.stringify(result), requiresFollowUp: true };
  },
});
