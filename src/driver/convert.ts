// TR data format conversion between openai-chat and responses.
// Called at API boundaries — never at storage time.
//
// Reasoning is preserved through conversions — sanitizeReasoningForTR already
// strips reasoning when compat mismatches. Data reaching these functions has
// valid reasoning that should survive the round-trip.
//
// Mapping: responses encrypted_content ↔ openai-chat reasoning_opaque
//          responses summary           ↔ openai-chat reasoning_text

import type { Message } from 'xsai';

import type {
  ResponseFunctionCallOutputItem,
  ResponseFunctionToolCallItem,
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseInputReasoning,
  ResponseOutputFunctionCall,
  ResponseOutputMessage,
} from './responses-types';
import type { TRAssistantEntry, TRDataEntry, TRToolResultEntry } from './types';

type AnyMsg = Record<string, any>;

// ── openai-chat TR data → Responses API input items ──
// Used when replaying openai-chat TRs to a Responses API model.
export const chatTRToResponsesInput = (entries: TRDataEntry[]): ResponseInputItem[] => {
  const items: ResponseInputItem[] = [];

  for (const entry of entries) {
    if (entry.role === 'assistant') {
      const assistant = entry as TRAssistantEntry;

      // Reasoning → ResponseInputReasoning (before message/tool_calls)
      if (assistant.reasoning_opaque) {
        items.push({
          type: 'reasoning',
          id: `rs_${items.length}`,
          summary: assistant.reasoning_text
            ? [{ type: 'summary_text', text: assistant.reasoning_text }]
            : [],
          encrypted_content: assistant.reasoning_opaque,
        } as ResponseInputReasoning);
      }

      // Text content → message with output_text
      if (assistant.content != null) {
        const content: ResponseInputContent[] = [];
        if (typeof assistant.content === 'string') {
          content.push({ type: 'output_text', text: assistant.content });
        } else if (Array.isArray(assistant.content)) {
          for (const part of assistant.content) {
            const p = part as AnyMsg;
            if (p.type === 'text')
              content.push({ type: 'output_text', text: p.text });
            // Skip thinking blocks
          }
        }
        if (content.length > 0)
          items.push({ type: 'message', role: 'assistant', content } as ResponseInputMessage);
      }

      // Tool calls → function_call items
      if (assistant.tool_calls) {
        for (const tc of assistant.tool_calls) {
          items.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
            status: 'completed',
          } as ResponseFunctionToolCallItem);
        }
      }
    } else if (entry.role === 'tool') {
      const tool = entry as TRToolResultEntry;
      items.push({
        type: 'function_call_output',
        call_id: tool.tool_call_id,
        output: tool.content,
      } as ResponseFunctionCallOutputItem);
    }
  }

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
    if (pendingContent != null || pendingToolCalls.length > 0
        || pendingReasoningOpaque != null || pendingReasoningText != null) {
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
    }
  };

  for (const raw of items) {
    const item = raw as AnyMsg;

    if (item.type === 'message') {
      const msg = item as ResponseOutputMessage;
      for (const block of msg.content) {
        if (block.type === 'output_text')
          pendingContent = (pendingContent ?? '') + block.text;
        if (block.type === 'refusal')
          pendingContent = (pendingContent ?? '') + block.refusal;
      }
    } else if (item.type === 'function_call') {
      const fc = item as ResponseOutputFunctionCall;
      pendingToolCalls.push({
        id: fc.call_id,
        type: 'function',
        function: { name: fc.name, arguments: fc.arguments },
      });
    } else if (item.type === 'reasoning') {
      if (item.encrypted_content)
        pendingReasoningOpaque = item.encrypted_content as string;
      if (Array.isArray(item.summary) && item.summary.length > 0) {
        const text = (item.summary as { text: string }[]).map(s => s.text).join('\n');
        if (text) pendingReasoningText = text;
      }
    } else if (item.type === 'function_call_output') {
      // Flush pending assistant before emitting tool result
      flushAssistant();
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: item.output,
      } as unknown as Message);
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
        const content: ResponseInputContent[] = [];
        for (const part of m.content) {
          if (part.type === 'text')
            content.push({ type: 'input_text', text: part.text });
          else if (part.type === 'image_url')
            content.push({ type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail ?? 'auto' });
        }
        if (content.length > 0)
          items.push({ type: 'message', role: 'user', content } as ResponseInputMessage);
      }
    } else if (m.role === 'assistant') {
      // Reasoning → ResponseInputReasoning (before message/tool_calls)
      if (m.reasoning_opaque) {
        items.push({
          type: 'reasoning',
          id: `rs_${items.length}`,
          summary: m.reasoning_text
            ? [{ type: 'summary_text', text: m.reasoning_text }]
            : [],
          encrypted_content: m.reasoning_opaque,
        } as ResponseInputReasoning);
      }

      // Text content → message with output_text
      if (m.content != null) {
        const content: ResponseInputContent[] = [];
        if (typeof m.content === 'string') {
          content.push({ type: 'output_text', text: m.content });
        } else if (Array.isArray(m.content)) {
          for (const part of m.content) {
            if (part.type === 'text')
              content.push({ type: 'output_text', text: part.text });
            // Skip thinking blocks
          }
        }
        if (content.length > 0)
          items.push({ type: 'message', role: 'assistant', content } as ResponseInputMessage);
      }

      // Tool calls → function_call items
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          items.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
            status: 'completed',
          } as ResponseFunctionToolCallItem);
        }
      }
    } else if (m.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: m.content,
      } as ResponseFunctionCallOutputItem);
    }
    // system/developer messages handled via instructions parameter, skip here
  }

  return items;
};
