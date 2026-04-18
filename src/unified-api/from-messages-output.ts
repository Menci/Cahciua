import type { MessagesAssistantContentBlock } from './anthropic-types';
import { pickExtra } from './shared';
import type { ConversationEntry, OutputPart, ReasoningPart } from './types';

const TEXT_CORE = new Set(['type', 'text']);
const TOOL_USE_CORE = new Set(['type', 'id', 'name', 'input']);
const THINKING_CORE = new Set(['type', 'thinking', 'signature']);
const REDACTED_THINKING_CORE = new Set(['type', 'data']);

/**
 * Runtime Messages response parser. Assistants produce text / tool_use /
 * thinking / redacted_thinking — never tool_result (which is user-side input).
 */
export const fromMessagesOutput = (blocks: MessagesAssistantContentBlock[]): ConversationEntry[] => {
  const parts = blocks.map(blockToPart);
  if (parts.length === 0) return [];
  return [{ kind: 'message', role: 'assistant', parts, reasoning: undefined }];
};

const blockToPart = (block: MessagesAssistantContentBlock): OutputPart => {
  if (block.type === 'text') {
    const part: OutputPart = { kind: 'text', text: block.text };
    const extra = pickExtra('anthropicMessages', block, TEXT_CORE);
    if (extra !== undefined) part.extra = extra;
    return part;
  }
  if (block.type === 'tool_use') {
    const part: OutputPart = {
      kind: 'toolCall',
      callId: block.id,
      name: block.name,
      args: JSON.stringify(block.input),
    };
    const extra = pickExtra('anthropicMessages', block, TOOL_USE_CORE);
    if (extra !== undefined) part.extra = extra;
    return part;
  }
  if (block.type === 'thinking') {
    const part: ReasoningPart = {
      kind: 'reasoning',
      data: {
        source: 'anthropicMessages',
        data: { type: 'thinking', thinking: block.thinking, signature: block.signature },
      },
    };
    const extra = pickExtra('anthropicMessages', block, THINKING_CORE);
    if (extra !== undefined) part.extra = extra;
    return part;
  }
  if (block.type === 'redacted_thinking') {
    const part: ReasoningPart = {
      kind: 'reasoning',
      data: {
        source: 'anthropicMessages',
        data: { type: 'redacted_thinking', data: block.data },
      },
    };
    const extra = pickExtra('anthropicMessages', block, REDACTED_THINKING_CORE);
    if (extra !== undefined) part.extra = extra;
    return part;
  }
  throw new Error(`Unknown Messages assistant content block type: ${(block as { type: string }).type}`);
};
