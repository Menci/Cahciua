import { createTool } from './create-tool';
import type { CahciuaTool } from './types';
import type { ConversationEntry } from '../../unified-api/types';

const DECIDE_TOOL_NAME = 'decide';

type DecideAction = 'send_message' | 'no_action';

interface DecideArgs {
  should_act: DecideAction;
  reason: string;
}

export const createDecideTool = (): CahciuaTool => createTool({
  name: DECIDE_TOOL_NAME,
  description:
    'Submit your prediction whether the chatbot will immediately perform new actions or send new messages to the chatroom.',
  parameters: {
    type: 'object',
    properties: {
      should_act: {
        type: 'string',
        enum: ['send_message', 'no_action'],
        description:
          '`send_message`: You predict that the chatbot will immediately perform new actions or send new messages to the chatroom.\n'
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
  value === 'send_message' || value === 'no_action';

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
