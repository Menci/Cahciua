// TR data format conversion between openai-chat and responses.
// Called at API boundaries — never at storage time.
//
// Reasoning is preserved through conversions — sanitizeReasoningForTR already
// strips reasoning when compat mismatches. Data reaching these functions has
// valid reasoning that should survive the round-trip.
//
// Mapping: responses encrypted_content ↔ openai-chat reasoning_opaque
//          responses summary           ↔ openai-chat reasoning_text

import type { Message, Tool } from 'xsai';

import type {
  ResponseFunctionCallOutputItem,
  ResponseFunctionToolCallItem,
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseInputReasoning,
  ResponseOutputFunctionCall,
  ResponseOutputMessage,
  ResponseTool,
} from './responses-types';
import type { TRAssistantEntry, TRDataEntry, TRToolResultEntry } from './types';

type AnyMsg = Record<string, any>;

// ── Shared assistant → Responses input items ──
// Extracts reasoning, message content, and tool_calls from an openai-chat-shaped
// assistant entry into Responses input items. Used by both chatTRToResponsesInput
// and messagesToResponsesInput — the two functions differ only in how they handle
// user and tool roles.
const assistantToResponsesItems = (
  m: AnyMsg,
  items: ResponseInputItem[],
) => {
  // Reasoning → ResponseInputReasoning (before message/tool_calls)
  if (m.reasoning_opaque)
    items.push({
      type: 'reasoning', id: `rs_${items.length}`,
      summary: m.reasoning_text ? [{ type: 'summary_text', text: m.reasoning_text }] : [],
      encrypted_content: m.reasoning_opaque,
    } as ResponseInputReasoning);

  // Text content → message with output_text
  if (m.content != null) {
    const content: ResponseInputContent[] = typeof m.content === 'string'
      ? [{ type: 'output_text', text: m.content }]
      : Array.isArray(m.content)
        ? (m.content as AnyMsg[]).flatMap(p => p.type === 'text' ? [{ type: 'output_text' as const, text: p.text as string }] : [])
        : [];
    if (content.length > 0)
      items.push({ type: 'message', role: 'assistant', content } as ResponseInputMessage);
  }

  // Tool calls → function_call items
  for (const tc of m.tool_calls ?? [])
    items.push({
      type: 'function_call', call_id: tc.id,
      name: tc.function.name, arguments: tc.function.arguments, status: 'completed',
    } as ResponseFunctionToolCallItem);
};

// ── openai-chat TR data → Responses API input items ──
// Used when replaying openai-chat TRs to a Responses API model.
export const chatTRToResponsesInput = (entries: TRDataEntry[]): ResponseInputItem[] => {
  const items: ResponseInputItem[] = [];
  for (const entry of entries)
    entry.role === 'assistant'
      ? assistantToResponsesItems(entry as TRAssistantEntry, items)
      : entry.role === 'tool' && items.push({
        type: 'function_call_output',
        call_id: (entry as TRToolResultEntry).tool_call_id,
        output: (entry as TRToolResultEntry).content,
      } as ResponseFunctionCallOutputItem);
  return items;
};

// ── Responses TR data → openai-chat Message[] ──
// Used when replaying responses TRs to a Chat Completions model.
// Handles all 4 item types: message, function_call, reasoning, function_call_output.
export const responsesOutputToMessages = (items: unknown[]): Message[] => {
  const messages: Message[] = [];

  let pendingContent: string | undefined;
  let pendingToolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
  let pendingReasoningOpaque: string | undefined;
  let pendingReasoningText: string | undefined;

  const flushAssistant = () => {
    if (pendingContent == null && pendingToolCalls.length === 0
        && pendingReasoningOpaque == null && pendingReasoningText == null) return;
    const msg: AnyMsg = { role: 'assistant' };
    if (pendingContent != null) msg.content = pendingContent;
    if (pendingToolCalls.length > 0) msg.tool_calls = pendingToolCalls;
    if (pendingReasoningOpaque != null) msg.reasoning_opaque = pendingReasoningOpaque;
    if (pendingReasoningText != null) msg.reasoning_text = pendingReasoningText;
    messages.push(msg as Message);
    pendingContent = undefined;
    pendingToolCalls = [];
    pendingReasoningOpaque = undefined;
    pendingReasoningText = undefined;
  };

  for (const raw of items) {
    const item = raw as AnyMsg;

    if (item.type === 'message') {
      for (const block of (item as ResponseOutputMessage).content)
        pendingContent = (pendingContent ?? '')
          + (block.type === 'output_text' ? block.text : block.type === 'refusal' ? block.refusal : '');
    } else if (item.type === 'function_call') {
      const fc = item as ResponseOutputFunctionCall;
      pendingToolCalls.push({ id: fc.call_id, type: 'function', function: { name: fc.name, arguments: fc.arguments } });
    } else if (item.type === 'reasoning') {
      if (item.encrypted_content) pendingReasoningOpaque = item.encrypted_content as string;
      const summaryText = Array.isArray(item.summary)
        ? (item.summary as { text: string }[]).map(s => s.text).join('\n')
        : '';
      if (summaryText) pendingReasoningText = summaryText;
    } else if (item.type === 'function_call_output') {
      flushAssistant();
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output } as unknown as Message);
    }
  }

  flushAssistant();
  return messages;
};

// ── openai-chat Message[] → Responses API input items ──
// Used by runner to convert composed context (always openai-chat format)
// into Responses API input before sending.
export const messagesToResponsesInput = (messages: Message[]): ResponseInputItem[] => {
  const items: ResponseInputItem[] = [];

  for (const msg of messages) {
    const m = msg as AnyMsg;

    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        items.push({ type: 'message', role: 'user', content: m.content } as ResponseInputMessage);
      } else if (Array.isArray(m.content)) {
        const content = (m.content as AnyMsg[]).flatMap((part): ResponseInputContent[] =>
          part.type === 'text' ? [{ type: 'input_text', text: part.text as string }]
            : part.type === 'image_url' ? [{ type: 'input_image', image_url: part.image_url.url as string, detail: (part.image_url.detail ?? 'auto') as 'auto' | 'low' | 'high' }]
              : []);
        if (content.length > 0) items.push({ type: 'message', role: 'user', content } as ResponseInputMessage);
      }
    } else if (m.role === 'assistant') {
      assistantToResponsesItems(m, items);
    } else if (m.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content } as ResponseFunctionCallOutputItem);
    }
  }

  return items;
};

// ── xsai Tool → Responses API function tool ──
export const xsaiToolToResponsesTool = (t: Tool): ResponseTool => ({
  type: 'function',
  name: t.function.name,
  parameters: t.function.parameters as Record<string, unknown>,
  strict: false,
  ...(t.function.description ? { description: t.function.description } : {}),
});
