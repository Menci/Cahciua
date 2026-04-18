/**
 * One-shot migration helpers for the `turn_responses` table.
 *
 * Stored rows hold Chat Completions or Responses wire data including tool
 * result entries, which never show up in a live API response. Runtime
 * `from-*Output` refuses tool-result inputs; this module owns that decoding
 * and is the only place it lives.
 *
 * Runtime code must not import this file.
 */

import sharp from 'sharp';

import type {
  ChatCompletionsAssistantMessage,
  ChatCompletionsEntry,
  ResponsesInputContent,
} from './chat-types';
import { fromChatCompletionsOutput } from './from-chat-output';
import { fromResponsesOutput } from './from-responses-output';
import type {
  ResponsesAssistantItem,
  ResponsesDataItem,
  ResponsesFunctionCallOutput,
} from './responses-types';
import type { ConversationEntry, InputPart, ToolResult } from './types';

export interface MigrationToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string | ResponsesInputContent[];
  requiresFollowUp?: boolean | number;
}

export interface MigrationFunctionCallOutput extends ResponsesFunctionCallOutput {
  requiresFollowUp?: boolean | number;
}

const asBool = (v: unknown): boolean => v === true || v === 1;

const dataUrlToBuffer = (url: string): Buffer => {
  const match = url.match(/^data:[^;]+;base64,(.+)$/);
  if (match === null) throw new Error(`Not a data URL: ${url.substring(0, 50)}`);
  return Buffer.from(match[1]!, 'base64');
};

const responsesContentToInputPart = (c: ResponsesInputContent): InputPart => {
  if (c.type === 'input_text' || c.type === 'output_text') {
    return { kind: 'text', text: c.text };
  }
  if (c.type === 'input_image') {
    return {
      kind: 'image',
      image: sharp(dataUrlToBuffer(c.image_url)),
      detail: c.detail === 'auto' ? undefined : c.detail,
    };
  }
  throw new Error(`Unknown content type: ${(c as { type: string }).type}`);
};

export const migrateChatEntries = (entries: (ChatCompletionsEntry | MigrationToolMessage)[]): ConversationEntry[] => {
  const out: ConversationEntry[] = [];
  for (const entry of entries) {
    if (entry.role === 'tool') out.push(toolMessageToResult(entry as MigrationToolMessage));
    else out.push(...fromChatCompletionsOutput([entry satisfies ChatCompletionsAssistantMessage]));
  }
  return out;
};

export const migrateResponsesEntries = (items: (ResponsesDataItem | MigrationFunctionCallOutput)[]): ConversationEntry[] => {
  const assistantItems: ResponsesAssistantItem[] = [];
  const out: ConversationEntry[] = [];

  const flushAssistant = () => {
    if (assistantItems.length === 0) return;
    out.push(...fromResponsesOutput(assistantItems));
    assistantItems.length = 0;
  };

  for (const item of items) {
    if (item.type === 'function_call_output') {
      flushAssistant();
      out.push(functionCallOutputToResult(item as MigrationFunctionCallOutput));
      continue;
    }
    assistantItems.push(item);
  }
  flushAssistant();
  return out;
};

const toolMessageToResult = (entry: MigrationToolMessage): ToolResult => ({
  kind: 'toolResult',
  callId: entry.tool_call_id,
  payload:
    typeof entry.content === 'string'
      ? entry.content
      : entry.content.map(responsesContentToInputPart),
  requiresFollowUp: asBool(entry.requiresFollowUp),
});

const functionCallOutputToResult = (item: MigrationFunctionCallOutput): ToolResult => {
  const payload: string | InputPart[] =
    typeof item.output === 'string'
      ? item.output
      : (item.output as ResponsesInputContent[]).map(responsesContentToInputPart);
  return {
    kind: 'toolResult',
    callId: item.call_id,
    payload,
    requiresFollowUp: asBool(item.requiresFollowUp),
  };
};
