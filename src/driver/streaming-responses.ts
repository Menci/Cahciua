import type { Logger } from '@guiiai/logg';

import type {
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponsesResult,
} from './responses-types';

export interface StreamingResponsesParams {
  baseURL: string;
  apiKey: string;
  model: string;
  input: unknown[];
  instructions?: string;
  tools?: { type: 'function'; name: string; parameters: Record<string, unknown>; description?: string }[];
  log: Logger;
  label: string;
}

export interface StreamingResponsesResult {
  output: ResponseOutputItem[];
  usage: { input_tokens: number; output_tokens: number };
  status: string;
}

// Parse a Responses API SSE stream into a StreamingResponsesResult.
// Logs content/reasoning/tool_call deltas as they arrive.
export const streamingResponses = async (params: StreamingResponsesParams): Promise<StreamingResponsesResult> => {
  const { log, label } = params;

  const tools = params.tools?.map(t => ({
    type: t.type,
    name: t.name,
    parameters: t.parameters,
    strict: false,
    ...(t.description ? { description: t.description } : {}),
  }));

  const body = JSON.stringify({
    model: params.model,
    input: params.input,
    ...(params.instructions ? { instructions: params.instructions } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    stream: true,
  });

  const url = `${params.baseURL.replace(/\/$/, '')}/responses`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${params.apiKey}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Responses API ${res.status}: ${text}`);
  }

  const stream = res.body;
  if (!stream) throw new Error('SSE response has no body');

  // Accumulated state
  const output: ResponseOutputItem[] = [];
  let usage = { input_tokens: 0, output_tokens: 0 };
  let status = '';

  // Logging buffers
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

  type AnyEvent = Record<string, any>;

  const processEvent = (event: AnyEvent) => {
    switch (event.type as string) {
    case 'response.output_item.added': {
      // Initialize the output item slot
      const item = event.item as ResponseOutputItem;
      output[event.output_index as number] = item;
      if (item.type === 'function_call') {
        flushTextBuf();
        flushReasoningBuf();
        log.withFields({ label, tool: (item as ResponseOutputFunctionCall).name }).log('tool call start');
      }
      break;
    }

    case 'response.output_text.delta': {
      textBuf += event.delta as string;
      // Update accumulated text in the message output item
      const msgItem = output[event.output_index as number] as ResponseOutputMessage | undefined;
      if (msgItem?.type === 'message' && msgItem.content[event.content_index as number]) {
        const block = msgItem.content[event.content_index as number]!;
        if (block.type === 'output_text')
          block.text += event.delta as string;
      }
      break;
    }

    case 'response.function_call_arguments.delta': {
      const fcItem = output[event.output_index as number] as ResponseOutputFunctionCall | undefined;
      if (fcItem?.type === 'function_call')
        fcItem.arguments += event.delta as string;
      break;
    }

    case 'response.reasoning_summary_text.delta': {
      reasoningBuf += event.delta as string;
      break;
    }

    case 'response.output_item.done': {
      // Replace with the final item from the server
      output[event.output_index as number] = event.item as ResponseOutputItem;
      break;
    }

    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed': {
      const resp = event.response as ResponsesResult;
      status = resp.status;
      if (resp.usage) {
        usage = {
          input_tokens: resp.usage.input_tokens,
          output_tokens: resp.usage.output_tokens,
        };
      }
      // Use the final output from the completed response
      if (resp.output) {
        output.length = 0;
        output.push(...resp.output);
      }
      break;
    }

    case 'error':
      log.withFields({ label, error: event.message }).error('Responses API stream error');
      break;

    default:
      break;
    }
  };

  // Parse SSE lines
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let lineBuf = '';

  const processLine = (line: string) => {
    if (!line.startsWith('data: ')) return;
    const data = line.slice(6).trim();
    if (data === '[DONE]') return;

    let parsed: AnyEvent;
    try { parsed = JSON.parse(data); } catch { return; }
    processEvent(parsed);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    lineBuf += decoder.decode(value, { stream: true });
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop()!;

    for (const line of lines)
      processLine(line);
  }

  if (lineBuf) processLine(lineBuf);
  flushTextBuf();
  flushReasoningBuf();

  return { output, usage, status };
};
