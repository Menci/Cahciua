import { createTool } from './create-tool';
import type { CahciuaTool } from './types';
import type { ConversationEntry } from '../../unified-api/types';

const DECIDE_TOOL_NAME = 'decide';

export type DecideAction = 'send_message' | 'any' | 'no_action';

export interface DecideArgs {
  should_act: DecideAction;
  reason: string;
}

export const createDecideTool = (): CahciuaTool => createTool({
  name: DECIDE_TOOL_NAME,
  description:
    'Submit your prediction of how the chatbot will act at this turn.',
  parameters: {
    type: 'object',
    properties: {
      should_act: {
        type: 'string',
        enum: ['send_message', 'any', 'no_action'],
        description:
          '`send_message`: You predict that the chatbot will send at least one message to the chatroom at this turn (optionally alongside reactions or other tool calls).\n'
          + '`any`: You predict that the chatbot will perform an action (such as a tool call or reaction) without needing to send a message, or where speaking is optional.\n'
          + '`no_action`: You predict that the chatbot will keep silent (no message, no reaction, no tool call) at this turn.',
      },
      reason: {
        type: 'string',
        description: 'Explain your judgement in one sentence.',
      },
    },
    required: ['should_act', 'reason'],
  },
  execute: () => ({ content: JSON.stringify({ ok: true }), requiresFollowUp: false }),
});

const isDecideAction = (value: unknown): value is DecideAction =>
  value === 'send_message' || value === 'any' || value === 'no_action';

export const extractDecideResult = (entries: ConversationEntry[]): DecideArgs | null => {
  for (const entry of entries) {
    if (entry.kind !== 'message' || entry.role !== 'assistant') continue;
    for (const part of entry.parts) {
      if (part.kind === 'toolCall' && part.name === DECIDE_TOOL_NAME) {
        try {
          const parsed = JSON.parse(part.args) as Partial<DecideArgs>;
          if (isDecideAction(parsed.should_act) && typeof parsed.reason === 'string')
            return { should_act: parsed.should_act, reason: parsed.reason };
        } catch {
          continue;
        }
      }
    }
  }
  return null;
};
