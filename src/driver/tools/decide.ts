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
    'Record your judgement on whether the bot should take any action this turn. '
    + 'Calling this tool IS the output of the evaluation; the arguments are the result.',
  parameters: {
    type: 'object',
    properties: {
      should_act: {
        type: 'string',
        enum: ['send_message', 'no_action'],
        description:
          '`send_message` — the bot should take action this turn, and that action MUST eventually produce at least one `send_message` call (other tools like `react`, `web_search`, `bash` may be chained before it). '
          + '`no_action` — the bot should do nothing at all this turn (no message, no reaction, no tool call).',
      },
      reason: {
        type: 'string',
        description: 'Brief, honest explanation of the judgement (one or two sentences). Speaks about the bot in third person.',
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
