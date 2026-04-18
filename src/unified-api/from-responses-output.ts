import type {
  ResponsesAssistantItem,
  ResponsesOutputFunctionCall,
  ResponsesOutputMessage,
} from './responses-types';
import { pickExtra } from './shared';
import type {
  ConversationEntry,
  OutputMessage,
  OutputPart,
  ReasoningPart,
  TextGroupPart,
  TextPart,
  ToolCallPart,
} from './types';

const MESSAGE_CORE = new Set(['type', 'role', 'content']);
const TEXT_BLOCK_CORE = new Set(['type', 'text']);
const REFUSAL_BLOCK_CORE = new Set(['type', 'refusal']);
const FUNCTION_CALL_CORE = new Set(['type', 'call_id', 'name', 'arguments']);
const REASONING_CORE = new Set(['type', 'id', 'summary', 'encrypted_content']);

/**
 * Runtime Responses API response parser. Assistant items only
 * (`message` / `function_call` / `reasoning`). `function_call_output` is
 * client-authored input and belongs to migrations.
 */
export const fromResponsesOutput = (items: ResponsesAssistantItem[]): ConversationEntry[] => {
  const parts: OutputPart[] = items.map(convertItem);
  if (parts.length === 0) return [];
  return [{ kind: 'message', role: 'assistant', parts, reasoning: undefined } satisfies OutputMessage];
};

const convertItem = (item: ResponsesAssistantItem): OutputPart => {
  if (item.type === 'message') return messageItemToGroup(item);
  if (item.type === 'function_call') return functionCallToPart(item);
  if (item.type === 'reasoning') {
    const part: ReasoningPart = {
      kind: 'reasoning',
      data: {
        source: 'openaiResponses',
        data: { type: 'reasoning', id: item.id, summary: item.summary, encrypted_content: item.encrypted_content },
      },
    };
    const extra = pickExtra('openaiResponses', item, REASONING_CORE);
    if (extra !== undefined) part.extra = extra;
    return part;
  }
  throw new Error(`Unknown Responses output item type: ${(item as { type: string }).type}`);
};

const messageItemToGroup = (msg: ResponsesOutputMessage): TextGroupPart => {
  if (msg.role !== 'assistant') {
    throw new Error(`fromResponsesOutput expected message.role=assistant, got ${msg.role as string}`);
  }
  const content: TextPart[] = msg.content.map(block => {
    if (block.type === 'output_text') {
      const part: TextPart = { kind: 'text', text: block.text };
      const extra = pickExtra('openaiResponses', block, TEXT_BLOCK_CORE);
      if (extra !== undefined) part.extra = extra;
      return part;
    }
    if (block.type === 'refusal') {
      const part: TextPart = { kind: 'text', text: block.refusal, refusal: true };
      const extra = pickExtra('openaiResponses', block, REFUSAL_BLOCK_CORE);
      if (extra !== undefined) part.extra = extra;
      return part;
    }
    throw new Error(`Unknown Responses content block type: ${(block as { type: string }).type}`);
  });
  const group: TextGroupPart = { kind: 'textGroup', content };
  const extra = pickExtra('openaiResponses', msg, MESSAGE_CORE);
  if (extra !== undefined) group.extra = extra;
  return group;
};

const functionCallToPart = (fc: ResponsesOutputFunctionCall): ToolCallPart => {
  const part: ToolCallPart = {
    kind: 'toolCall',
    callId: fc.call_id,
    name: fc.name,
    args: fc.arguments,
  };
  const extra = pickExtra('openaiResponses', fc, FUNCTION_CALL_CORE);
  if (extra !== undefined) part.extra = extra;
  return part;
};
