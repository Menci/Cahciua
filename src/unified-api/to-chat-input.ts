import type {
  ChatCompletionsAssistantMessage,
  ChatCompletionsContentPart,
  ChatCompletionsEntry,
  ChatCompletionsToolCall,
  ChatCompletionsToolMessage,
} from './chat-types';
import { flattenResponsesSummary } from './reasoning';
import { applyExtra, assertSystemTextOnly, inputPartToChatContent } from './shared';
import type {
  ConversationEntry,
  InputMessage,
  OutputMessage,
  OutputPart,
  ReasoningData,
  ReasoningPart,
  TextPart,
  ThinkingData,
  ToolCallPart,
  ToolResult,
} from './types';

interface ChatCompletionsSystemOrUserMessage {
  role: 'system' | 'user';
  content: string | ChatCompletionsContentPart[];
}

type OutgoingEntry = ChatCompletionsEntry | ChatCompletionsSystemOrUserMessage;

/**
 * Runtime request builder for Chat Completions. Handles all roles
 * (system / user / assistant / toolResult).
 *
 * OpenAI Chat Completions does not accept image parts inside `role:'tool'`
 * content — so when a ToolResult carries images, we emit the tool message with
 * a text-only placeholder and hoist the actual images into an immediately
 * following `role:'user'` message.
 */
export const toChatCompletionsInput = async (entries: ConversationEntry[]): Promise<OutgoingEntry[]> => {
  const out: OutgoingEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'toolResult') {
      const { toolMsg, hoistedImages } = await toolResultToToolMessage(entry);
      out.push(toolMsg);
      if (hoistedImages.length > 0) {
        out.push({
          role: 'user',
          content: [
            { type: 'text', text: `(Images from tool result ${entry.callId}:)` },
            ...hoistedImages,
          ],
        });
      }
    } else if (entry.role === 'assistant') {
      out.push(await messageToAssistant(entry));
    } else {
      out.push(await inputMessageToEntry(entry));
    }
  }
  return out;
};

const inputMessageToEntry = async (msg: InputMessage): Promise<ChatCompletionsSystemOrUserMessage> => {
  assertSystemTextOnly(msg);
  return msg.parts.length === 1 && msg.parts[0]!.kind === 'text'
    ? { role: msg.role, content: msg.parts[0]!.text }
    : { role: msg.role, content: await Promise.all(msg.parts.map(inputPartToChatContent)) };
};

const flattenTextParts = (parts: OutputPart[]): TextPart[] =>
  parts.flatMap(p => p.kind === 'text' ? [p] : p.kind === 'textGroup' ? p.content : []);

const textPartToContentPart = (tp: TextPart): ChatCompletionsContentPart =>
  applyExtra(tp.extra, 'openaiChatCompletion', { higher: { type: 'text' as const, text: tp.text } });

/** String shortcut is safe only when nothing source-specific needs to ride on the block. */
const hasSameSourceExtra = (tp: TextPart): boolean => tp.extra?.source === 'openaiChatCompletion';

const reasoningToContentPart = (part: ReasoningPart): ChatCompletionsContentPart | undefined => {
  const thinking = reasoningToThinking(part.data);
  if (thinking === undefined) return undefined;
  return applyExtra(part.extra, 'openaiChatCompletion', { higher: { ...thinking } });
};

const reasoningToThinking = (data: ReasoningData): ThinkingData | { type: 'redacted_thinking'; data: string } | undefined => {
  if (data.source === 'openaiResponses') {
    const text = flattenResponsesSummary(data.data.summary);
    const sig = data.data.encrypted_content;
    if (text.length === 0 && sig === undefined) return undefined;
    // Empty summary + opaque signature → redacted_thinking (normalize with
    // other formats so opaque-only reasoning is always redacted).
    if (text.length === 0 && sig !== undefined) return { type: 'redacted_thinking', data: sig };
    return { type: 'thinking', thinking: text, signature: sig };
  }
  return data.data;
};

const messageToAssistant = async (msg: OutputMessage): Promise<ChatCompletionsAssistantMessage> => {
  const core: Record<string, unknown> = { role: 'assistant' };

  const hasReasoning = msg.parts.some(p => p.kind === 'reasoning');
  const textParts = flattenTextParts(msg.parts);
  const toolCallParts = msg.parts.filter((p): p is ToolCallPart => p.kind === 'toolCall');

  if (hasReasoning) {
    const contentParts = msg.parts.flatMap((part): ChatCompletionsContentPart[] => {
      if (part.kind === 'reasoning') {
        const cp = reasoningToContentPart(part);
        return cp !== undefined ? [cp] : [];
      }
      if (part.kind === 'text') return [textPartToContentPart(part)];
      if (part.kind === 'textGroup') return part.content.map(textPartToContentPart);
      return [];
    });
    if (contentParts.length > 0) core.content = contentParts;
  } else if (textParts.length === 1 && !hasSameSourceExtra(textParts[0]!)) {
    core.content = textParts[0]!.text;
  } else if (textParts.length >= 1) {
    core.content = textParts.map(textPartToContentPart);
  }

  if (toolCallParts.length > 0) {
    core.tool_calls = toolCallParts.map((part): ChatCompletionsToolCall =>
      applyExtra(part.extra, 'openaiChatCompletion', {
        higher: {
          id: part.callId,
          type: 'function' as const,
          function: { name: part.name, arguments: part.args },
        },
      }));
  }

  // Order: extra < msg.reasoning (string alias fields) < core.
  // msg.reasoning fields (reasoning_content etc.) override same-keyed extras;
  // core role/content/tool_calls always win.
  const merged = applyExtra(msg.extra, 'openaiChatCompletion', {
    higher: { ...(msg.reasoning ?? {}), ...core },
  });
  return merged as ChatCompletionsAssistantMessage;
};

const toolResultToToolMessage = async (
  tr: ToolResult,
): Promise<{ toolMsg: ChatCompletionsToolMessage; hoistedImages: ChatCompletionsContentPart[] }> => {
  if (typeof tr.payload === 'string')
    return { toolMsg: { role: 'tool', tool_call_id: tr.callId, content: tr.payload }, hoistedImages: [] };

  const textParts = tr.payload.filter(p => p.kind === 'text');
  const imageParts = tr.payload.filter(p => p.kind === 'image');
  const hoistedImages = await Promise.all(imageParts.map(inputPartToChatContent));

  const textContent = textParts.length === 1
    ? (textParts[0] as { text: string }).text
    : textParts.length > 1
      ? (await Promise.all(textParts.map(inputPartToChatContent))) as ChatCompletionsContentPart[]
      : '';
  const content: string | ChatCompletionsContentPart[] = hoistedImages.length > 0
    ? (textContent || `[Refer to the image below for tool result ${tr.callId}]`)
    : textContent;
  return {
    toolMsg: { role: 'tool', tool_call_id: tr.callId, content },
    hoistedImages,
  };
};
