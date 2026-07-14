import { createTool } from './create-tool';
import type { CahciuaTool } from './types';

const END_TURN_TOOL_NAME = 'end_turn';

export const createEndTurnTool = (): CahciuaTool => createTool({
  name: END_TURN_TOOL_NAME,
  description:
    'Signal that you are done with this turn and have nothing more to do. '
    + 'Calling this ends the current turn cleanly. Use this only when no other '
    + 'action is appropriate — never as a substitute for an action you should be taking.',
  parameters: { type: 'object', properties: {} },
  execute: () => ({ content: JSON.stringify({ ok: true }), requiresFollowUp: false }),
});
