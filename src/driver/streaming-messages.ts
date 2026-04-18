import type { Logger } from '@guiiai/logg';

import { parseSSEStream } from './sse';
import type {
  MessagesAssistantContentBlock,
  MessagesMessage,
  MessagesResponse,
} from '../unified-api/anthropic-types';

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface StreamingMessagesParams {
  baseURL: string;
  apiKey: string;
  model: string;
  system?: string;
  messages: MessagesMessage[];
  tools?: AnthropicTool[];
  maxTokens?: number;
  timeoutSec?: number;
  log: Logger;
  label: string;
}

export interface StreamingMessagesResult {
  content: MessagesAssistantContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: MessagesResponse['stop_reason'];
}

type SSEEvent =
  | { type: 'message_start'; message: { usage?: { input_tokens?: number; output_tokens?: number } } }
  | { type: 'content_block_start'; index: number; content_block: MessagesAssistantContentBlock }
  | { type: 'content_block_delta'; index: number; delta: {
    type: 'text_delta'; text: string;
  } | {
    type: 'input_json_delta'; partial_json: string;
  } | {
    type: 'thinking_delta'; thinking: string;
  } | {
    type: 'signature_delta'; signature: string;
  }; }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: MessagesResponse['stop_reason'] }; usage?: { output_tokens?: number } }
  | { type: 'message_stop' }
  | { type: 'error'; error: { type: string; message: string } }
  | { type: 'ping' };

export const streamingMessages = async (params: StreamingMessagesParams): Promise<StreamingMessagesResult> => {
  const { log, label } = params;
  const abortController = new AbortController();
  const timeout = params.timeoutSec
    ? setTimeout(() => abortController.abort(new Error(`messages request timed out after ${params.timeoutSec}s`)), params.timeoutSec * 1000)
    : undefined;

  try {
    const body = JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens ?? 8192,
      ...(params.system ? { system: params.system } : {}),
      messages: params.messages,
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
      stream: true,
    });

    const url = `${params.baseURL.replace(/\/$/, '')}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': params.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
      signal: abortController.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Messages API ${res.status}: ${text}`);
    }

    const stream = res.body;
    if (!stream) throw new Error('SSE response has no body');

    const content: MessagesAssistantContentBlock[] = [];
    // Buffer tool_use partial_json per index, stringify at block_stop.
    const toolJsonBuffers = new Map<number, string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: MessagesResponse['stop_reason'] = null;

    let textBuf = '';
    let reasoningBuf = '';
    const flushTextBuf = () => {
      if (textBuf) { log.withFields({ label, text: textBuf }).log('content delta'); textBuf = ''; }
    };
    const flushReasoningBuf = () => {
      if (reasoningBuf) { log.withFields({ label, reasoning: reasoningBuf }).log('reasoning delta'); reasoningBuf = ''; }
    };

    const processEvent = (event: SSEEvent) => {
      switch (event.type) {
      case 'message_start':
        if (event.message.usage?.input_tokens != null)
          inputTokens = event.message.usage.input_tokens;
        if (event.message.usage?.output_tokens != null)
          outputTokens = event.message.usage.output_tokens;
        break;

      case 'content_block_start': {
        const block = { ...event.content_block };
        if (block.type === 'tool_use') {
          flushTextBuf();
          flushReasoningBuf();
          toolJsonBuffers.set(event.index, '');
          log.withFields({ label, tool: block.name }).log('tool call start');
        }
        content[event.index] = block;
        break;
      }

      case 'content_block_delta': {
        const block = content[event.index];
        if (!block) break;
        if (event.delta.type === 'text_delta' && block.type === 'text') {
          textBuf += event.delta.text;
          block.text = (block.text ?? '') + event.delta.text;
        } else if (event.delta.type === 'input_json_delta') {
          const existing = toolJsonBuffers.get(event.index) ?? '';
          toolJsonBuffers.set(event.index, existing + event.delta.partial_json);
        } else if (event.delta.type === 'thinking_delta' && block.type === 'thinking') {
          reasoningBuf += event.delta.thinking;
          block.thinking = (block.thinking ?? '') + event.delta.thinking;
        } else if (event.delta.type === 'signature_delta' && block.type === 'thinking') {
          block.signature = (block.signature ?? '') + event.delta.signature;
        }
        break;
      }

      case 'content_block_stop': {
        const block = content[event.index];
        if (block?.type === 'tool_use') {
          const raw = toolJsonBuffers.get(event.index) ?? '';
          try {
            block.input = raw ? JSON.parse(raw) as Record<string, unknown> : {};
          } catch {
            block.input = {};
          }
          toolJsonBuffers.delete(event.index);
        }
        break;
      }

      case 'message_delta':
        stopReason = event.delta.stop_reason;
        if (event.usage?.output_tokens != null)
          outputTokens = event.usage.output_tokens;
        break;

      case 'error':
        log.withFields({ label, error: event.error }).error('Messages API stream error');
        break;

      default:
        break;
      }
    };

    await parseSSEStream<SSEEvent>(stream, processEvent);
    flushTextBuf();
    flushReasoningBuf();

    return {
      content: content.filter((b): b is MessagesAssistantContentBlock => b != null),
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      stop_reason: stopReason,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
