import type { Logger } from '@guiiai/logg';
import type { Message, Tool } from 'xsai';
import { chat } from 'xsai';

type AnyMsg = Record<string, any>;

export interface StreamingChatParams {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: Message[];
  system?: string;
  tools?: Tool[];
  log: Logger;
  label: string; // log prefix, e.g. "step" or "compact"
}

export interface StreamingChatResult {
  choices: Array<{ finish_reason: string; message: AnyMsg }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

// Parse an OpenAI-compatible SSE stream into a single ChatCompletion-shaped result.
// Logs every content/reasoning/tool_call delta as it arrives.
export const streamingChat = async (params: StreamingChatParams): Promise<StreamingChatResult> => {
  const { log, label } = params;

  const res = await chat({
    baseURL: params.baseURL,
    apiKey: params.apiKey,
    model: params.model,
    messages: params.messages,
    tools: params.tools,
    system: params.system,
    stream: true,
    streamOptions: { includeUsage: true },
  } as any);

  const body = res.body;
  if (!body) throw new Error('SSE response has no body');

  // Accumulated state for the single choice we care about
  let finishReason = '';
  const message: AnyMsg = { role: 'assistant' };
  let usage = { prompt_tokens: 0, completion_tokens: 0 };

  // Accumulators for logging batched deltas
  let textBuf = '';
  let reasoningBuf = '';

  const flushTextBuf = () => {
    if (textBuf) {
      log.withFields({ label, text: textBuf }).log('content delta');
      textBuf = '';
    }
  };

  const flushReasoningBuf = () => {
    if (reasoningBuf) {
      log.withFields({ label, reasoning: reasoningBuf }).log('reasoning delta');
      reasoningBuf = '';
    }
  };

  // Parse SSE lines from the byte stream
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = '';

  const processLine = (line: string) => {
    if (!line.startsWith('data: ')) return;
    const data = line.slice(6).trim();
    if (data === '[DONE]') return;

    let chunk: any;
    try { chunk = JSON.parse(data); } catch { return; }

    // Usage (comes in the final chunk when streamOptions.includeUsage is true)
    if (chunk.usage) {
      usage = {
        prompt_tokens: chunk.usage.prompt_tokens ?? 0,
        completion_tokens: chunk.usage.completion_tokens ?? 0,
      };
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;

    if (chunk.choices[0].finish_reason)
      finishReason = chunk.choices[0].finish_reason;

    // Content text
    if (delta.content) {
      textBuf += delta.content;
      message.content ??= '';
      message.content += delta.content;
    }

    // Reasoning (OpenAI-compat extended thinking)
    if (delta.reasoning_text) {
      reasoningBuf += delta.reasoning_text;
      message.reasoning_text ??= '';
      message.reasoning_text += delta.reasoning_text;
    }
    if (delta.reasoning_content) {
      reasoningBuf += delta.reasoning_content;
      message.reasoning_content ??= '';
      message.reasoning_content += delta.reasoning_content;
    }

    // Reasoning opaque signature (comes as a single chunk)
    if (delta.reasoning_opaque) {
      message.reasoning_opaque = (message.reasoning_opaque ?? '') + delta.reasoning_opaque;
    }

    // Tool calls — accumulate incrementally
    if (delta.tool_calls) {
      message.tool_calls ??= [];
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        message.tool_calls[idx] ??= {
          id: tc.id ?? '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        const existing = message.tool_calls[idx];
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) {
          flushTextBuf();
          flushReasoningBuf();
          existing.function.name += tc.function.name;
          log.withFields({ label, tool: existing.function.name }).log('tool call start');
        }
        if (tc.function?.arguments) {
          existing.function.arguments += tc.function.arguments;
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    lineBuf += decoder.decode(value, { stream: true });
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop()!; // keep incomplete last line

    for (const line of lines)
      processLine(line);
  }

  // Process any remaining data in buffer
  if (lineBuf) processLine(lineBuf);
  flushTextBuf();
  flushReasoningBuf();

  return {
    choices: [{ finish_reason: finishReason, message }],
    usage,
  };
};
