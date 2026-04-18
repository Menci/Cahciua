import type { ResponsesInputContent } from './chat-types';
import { messageReasoningText } from './reasoning';
import type {
  ResponsesDataItem,
  ResponsesFunctionCallOutput,
  ResponsesOutputContentBlock,
  ResponsesOutputFunctionCall,
  ResponsesOutputMessage,
  ResponsesOutputReasoning,
} from './responses-types';
import { applyExtra, assertSystemTextOnly, inputPartToResponsesContent } from './shared';
import type {
  ConversationEntry,
  InputMessage,
  MessageReasoning,
  OutputMessage,
  OutputPart,
  ReasoningPart,
  TextPart,
  ToolResult,
} from './types';

interface ResponsesInputMessage {
  type: 'message';
  role: 'system' | 'user';
  content: string | ResponsesInputContent[];
}

type ResponsesInputItem = ResponsesDataItem | ResponsesInputMessage;

/** Runtime request builder for OpenAI Responses. Handles all roles. */
export const toResponsesInput = async (entries: ConversationEntry[]): Promise<ResponsesInputItem[]> => {
  let crossIndex = 0;
  const mkCrossId = (): string => `rs_cross_${crossIndex++}`;
  const chunks = await Promise.all(entries.map((entry): Promise<ResponsesInputItem[]> =>
    entry.kind === 'toolResult' ? toolResultToItem(entry).then(i => [i])
      : entry.role === 'assistant' ? Promise.resolve(messageToItems(entry, mkCrossId))
        : inputMessageToItem(entry).then(i => [i])));
  return chunks.flat();
};

const inputMessageToItem = async (msg: InputMessage): Promise<ResponsesInputMessage> => {
  assertSystemTextOnly(msg);
  return msg.parts.length === 1 && msg.parts[0]!.kind === 'text'
    ? { type: 'message', role: msg.role, content: msg.parts[0]!.text }
    : { type: 'message', role: msg.role, content: await Promise.all(msg.parts.map(inputPartToResponsesContent)) };
};

const textPartToBlock = (tp: TextPart): ResponsesOutputContentBlock =>
  tp.refusal === true
    ? applyExtra(tp.extra, 'openaiResponses', { higher: { type: 'refusal' as const, refusal: tp.text } })
    : applyExtra(tp.extra, 'openaiResponses', { higher: { type: 'output_text' as const, text: tp.text } });

const reasoningToItem = (part: ReasoningPart, mkCrossId: () => string): ResponsesOutputReasoning | undefined => {
  const data = part.data;
  const build = (higher: ResponsesOutputReasoning): ResponsesOutputReasoning =>
    applyExtra(part.extra, 'openaiResponses', { lower: { status: 'completed' }, higher });
  if (data.source === 'openaiResponses') {
    const { id, summary, encrypted_content } = data.data;
    return build({ type: 'reasoning', id, summary, encrypted_content });
  }
  if (data.data.type === 'redacted_thinking') {
    return build({
      type: 'reasoning',
      id: mkCrossId(),
      summary: [],
      encrypted_content: data.data.data,
    });
  }
  const { thinking, signature } = data.data;
  return build({
    type: 'reasoning',
    id: mkCrossId(),
    summary: thinking.length > 0 ? [{ type: 'summary_text', text: thinking }] : [],
    encrypted_content: signature,
  });
};

const messageReasoningToItem = (r: MessageReasoning, mkCrossId: () => string): ResponsesOutputReasoning | undefined => {
  const text = messageReasoningText(r);
  const opaque = typeof r.reasoning_opaque === 'string' ? r.reasoning_opaque : undefined;
  if (text === undefined && opaque === undefined) return undefined;
  return {
    type: 'reasoning',
    id: mkCrossId(),
    summary: text !== undefined ? [{ type: 'summary_text', text }] : [],
    encrypted_content: opaque,
    status: 'completed',
  };
};

const partToItems = (part: OutputPart, msgExtra: OutputMessage['extra'], mkCrossId: () => string): ResponsesDataItem[] => {
  if (part.kind === 'textGroup') {
    const item: ResponsesOutputMessage = applyExtra(part.extra, 'openaiResponses', {
      lower: { status: 'completed' },
      higher: {
        type: 'message' as const,
        role: 'assistant',
        content: part.content.map(textPartToBlock),
      },
    });
    return [item];
  }
  if (part.kind === 'text') {
    const item: ResponsesOutputMessage = applyExtra(msgExtra, 'openaiResponses', {
      lower: { status: 'completed' },
      higher: {
        type: 'message' as const,
        role: 'assistant',
        content: [textPartToBlock(part)],
      },
    });
    return [item];
  }
  if (part.kind === 'reasoning') {
    const item = reasoningToItem(part, mkCrossId);
    return item !== undefined ? [item] : [];
  }
  if (part.kind === 'toolCall') {
    const item: ResponsesOutputFunctionCall = applyExtra(part.extra, 'openaiResponses', {
      lower: { status: 'completed' },
      higher: {
        type: 'function_call' as const,
        call_id: part.callId,
        name: part.name,
        arguments: part.args,
      },
    });
    return [item];
  }
  throw new Error(`Unknown OutputPart kind: ${(part as { kind: string }).kind}`);
};

const messageToItems = (msg: OutputMessage, mkCrossId: () => string): ResponsesDataItem[] => {
  const items = msg.parts.flatMap(part => partToItems(part, msg.extra, mkCrossId));
  if (msg.reasoning !== undefined && !msg.parts.some(p => p.kind === 'reasoning')) {
    const reasoningItem = messageReasoningToItem(msg.reasoning, mkCrossId);
    if (reasoningItem !== undefined) items.unshift(reasoningItem);
  }
  return items;
};

const toolResultToItem = async (tr: ToolResult): Promise<ResponsesFunctionCallOutput> => {
  const output: string | ResponsesInputContent[] =
    typeof tr.payload === 'string'
      ? tr.payload
      : await Promise.all(tr.payload.map(inputPartToResponsesContent));
  return { type: 'function_call_output', call_id: tr.callId, output };
};
