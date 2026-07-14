import { createTool } from './create-tool';
import type { CahciuaTool } from './types';

const SLEEP_MAX_SECONDS = 300;

export const createSleepTool = (): CahciuaTool => createTool({
  name: 'sleep',
  description: 'Pause execution for a specified number of seconds before continuing. Use this to wait for an external process to finish, avoid busy-polling, or introduce a deliberate delay before the next action.',
  parameters: {
    type: 'object',
    properties: {
      seconds: {
        type: 'number',
        minimum: 1,
        maximum: SLEEP_MAX_SECONDS,
        description: `Seconds to sleep. Must be between 1 and ${SLEEP_MAX_SECONDS}.`,
      },
      reason: {
        type: 'string',
        description: 'Brief note on why you are sleeping (not shown to anyone).',
      },
    },
    required: ['seconds'],
  },
  execute: async input => {
    const { seconds } = input as { seconds: number };
    await new Promise<void>(resolve => setTimeout(resolve, seconds * 1000));
    return { content: JSON.stringify({ ok: true, slept_seconds: seconds }), requiresFollowUp: true };
  },
});
