import { createTool } from './create-tool';
import type { CahciuaTool } from './types';

const END_TURN_TOOL_NAME = 'end_turn';

export const createEndTurnTool = (): CahciuaTool => createTool({
  name: END_TURN_TOOL_NAME,
  // Besides the description listed below, `end_turn` also triggers the
  // `loopEndedWithoutSendMessage` check.
  // Notice: Do not leak the actual `loopEndedWithoutSendMessage` logic into the
  // system prompt or the tool definition. This `end_turn` tool works better
  // when the LLM does not know the full logic behind it.
  description:
    'Signal that you are done with this turn and have nothing more to do. '
    + 'After calling \`end_turn\`, you will proceed to receive new incoming messages and notifications of completed background tasks (if any) for next turns.',
  parameters: { type: 'object', properties: {} },
  execute: () => ({ content: JSON.stringify({ ok: true }), requiresFollowUp: false }),
});
