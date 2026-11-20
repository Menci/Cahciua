import { describe, expect, it, vi } from 'vitest';

import { callLlm } from '../llm/call';

const entries = [{ kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'hi' }] }] as never;
const tools = [
  { name: 'send_message', description: 'a', parameters: { type: 'object', properties: {} } },
  { name: 'bash', description: 'b', parameters: { type: 'object', properties: {} } },
];
const log = { withError: () => log, withFields: () => log, error: () => {}, log: () => {} } as never;

type Format = 'anthropic-messages' | 'openai-chat' | 'responses';

const providerResponse = (format: Format) => {
  if (format === 'anthropic-messages') {
    return {
      id: 'x', model: 'm', role: 'assistant', type: 'message',
      content: [{ type: 'tool_use', id: 't1', name: 'send_message', input: {} }],
      stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  if (format === 'openai-chat') {
    return {
      id: 'x', model: 'm',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'send_message', arguments: '{}' } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
  }
  return {
    id: 'x', model: 'm', object: 'response', status: 'completed',
    output: [{ type: 'function_call', id: 't1', call_id: 't1', name: 'send_message', arguments: '{}' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
};

const capture = async (mode: 'specified' | 'filtered' | undefined, format: Format = 'anthropic-messages') => {
  const captured: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    captured.push(JSON.parse(init.body));
    return new Response(JSON.stringify(providerResponse(format)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  await callLlm(
    { apiBaseUrl: 'http://x', apiKey: 'k', model: 'm', apiFormat: format, forcedToolChoiceMode: mode, forceToolChoice: { name: 'send_message' } } as never,
    entries, 'sys', tools as never, { log, label: 't', dumpId: 'd' } as never,
  );
  vi.unstubAllGlobals();
  return captured[0];
};

describe('forcedToolChoiceMode', () => {
  it('specified: all tools + named tool_choice', async () => {
    const body = await capture('specified');
    expect(body.tools.map((t: any) => t.name)).toEqual(['send_message', 'bash']);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'send_message' });
  });

  it('filtered: one tool + any', async () => {
    const body = await capture('filtered');
    expect(body.tools.map((t: any) => t.name)).toEqual(['send_message']);
    expect(body.tool_choice).toEqual({ type: 'any' });
  });

  it('defaults to specified', async () => {
    const body = await capture(undefined);
    expect(body.tools.map((t: any) => t.name)).toEqual(['send_message', 'bash']);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'send_message' });
  });

  it('applies to openai-chat', async () => {
    const specified = await capture('specified', 'openai-chat');
    expect(specified.tools.map((t: any) => t.function.name)).toEqual(['send_message', 'bash']);
    expect(specified.tool_choice).toEqual({ type: 'function', function: { name: 'send_message' } });

    const filtered = await capture('filtered', 'openai-chat');
    expect(filtered.tools.map((t: any) => t.function.name)).toEqual(['send_message']);
    expect(filtered.tool_choice).toBe('required');
  });

  it('applies to responses', async () => {
    const specified = await capture('specified', 'responses');
    expect(specified.tools.map((t: any) => t.name)).toEqual(['send_message', 'bash']);
    expect(specified.tool_choice).toEqual({ type: 'function', name: 'send_message' });

    const filtered = await capture('filtered', 'responses');
    expect(filtered.tools.map((t: any) => t.name)).toEqual(['send_message']);
    expect(filtered.tool_choice).toBe('required');
  });

  it('rejects a forced name that is not among the offered tools', async () => {
    await expect(capture('filtered').then(() => callLlm(
      { apiBaseUrl: 'http://x', apiKey: 'k', model: 'm', apiFormat: 'anthropic-messages', forcedToolChoiceMode: 'filtered', forceToolChoice: { name: 'nope' } } as never,
      entries, 'sys', tools as never, { log, label: 't', dumpId: 'd' } as never,
    ))).rejects.toThrow('unknown tool');
  });
});
