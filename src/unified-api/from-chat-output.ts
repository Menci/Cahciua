import type {
  ChatCompletionsAssistantMessage,
  ChatCompletionsContentPart,
} from './chat-types';
import { pickExtra } from './shared';
import type {
  ConversationEntry,
  MessageReasoning,
  OutputMessage,
  OutputPart,
  ReasoningPart,
  TextPart,
  ToolCallPart,
} from './types';

const ASSISTANT_CORE = new Set([
  'role', 'content', 'tool_calls',
  'reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_opaque',
]);
const TOOL_CALL_CORE = new Set(['id', 'type', 'function']);
const TEXT_PART_CORE = new Set(['type', 'text']);
const THINKING_CORE = new Set(['type', 'thinking', 'signature']);
const REDACTED_THINKING_CORE = new Set(['type', 'data']);
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_opaque'] as const;

/**
 * Runtime Chat Completions response parser. Assistant entries only —
 * `tool` entries are client-authored input and belong to migrations.
 */
export const fromChatCompletionsOutput = (entries: ChatCompletionsAssistantMessage[]): ConversationEntry[] =>
  entries.map(assistantToMessage);

const assistantToMessage = (entry: ChatCompletionsAssistantMessage): OutputMessage => {
  const contentParts: OutputPart[] =
    typeof entry.content === 'string'
      ? [{ kind: 'text', text: entry.content }]
      : Array.isArray(entry.content)
        ? entry.content.map(contentBlockToPart)
        : [];

  const toolCallParts: OutputPart[] = (entry.tool_calls ?? []).map((tc): ToolCallPart => {
    const part: ToolCallPart = {
      kind: 'toolCall',
      callId: tc.id,
      name: tc.function.name,
      args: tc.function.arguments,
    };
    const extra = pickExtra('openaiChatCompletion', tc, TOOL_CALL_CORE);
    if (extra !== undefined) part.extra = extra;
    return part;
  });

  const reasoning = extractMessageReasoning(entry);
  const msg: OutputMessage = {
    kind: 'message',
    role: 'assistant',
    parts: [...contentParts, ...toolCallParts],
    reasoning,
  };
  const extra = pickExtra('openaiChatCompletion', entry, ASSISTANT_CORE);
  if (extra !== undefined) msg.extra = extra;
  return msg;
};

const extractMessageReasoning = (entry: ChatCompletionsAssistantMessage): MessageReasoning | undefined => {
  const result: MessageReasoning = {};
  let found = false;
  for (const key of REASONING_FIELDS) {
    const v = entry[key];
    if (typeof v === 'string') {
      result[key] = v;
      found = true;
    }
  }
  return found ? result : undefined;
};

const contentBlockToPart = (block: ChatCompletionsContentPart): OutputPart => {
  if (block.type === 'text' && typeof block.text === 'string') {
    const part: TextPart = { kind: 'text', text: block.text };
    const extra = pickExtra('openaiChatCompletion', block, TEXT_PART_CORE);
    if (extra !== undefined) part.extra = extra;
    return part;
  }
  if (block.type === 'thinking') {
    const part: ReasoningPart = {
      kind: 'reasoning',
      data: {
        source: 'openaiChatCompletion',
        data: { type: 'thinking', thinking: block.thinking as string, signature: block.signature as string | undefined },
      },
    };
    const extra = pickExtra('openaiChatCompletion', block, THINKING_CORE);
    if (extra !== undefined) part.extra = extra;
    return part;
  }
  if (block.type === 'redacted_thinking') {
    const part: ReasoningPart = {
      kind: 'reasoning',
      data: {
        source: 'openaiChatCompletion',
        data: { type: 'redacted_thinking', data: block.data as string },
      },
    };
    const extra = pickExtra('openaiChatCompletion', block, REDACTED_THINKING_CORE);
    if (extra !== undefined) part.extra = extra;
    return part;
  }
  throw new Error(`Unknown Chat content part type: ${block.type}`);
};
