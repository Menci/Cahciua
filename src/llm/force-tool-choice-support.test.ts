import { describe, expect, it, vi } from 'vitest';

import { callLlm } from './call';
import type { ForceToolChoiceSupport } from './types';

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

const capture = async (opts: {
  support?: ForceToolChoiceSupport;
  reasoningEffort?: string;
  needsForcedOutput?: boolean;
  format?: Format;
}) => {
  const format = opts.format ?? 'anthropic-messages';
  const captured: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    captured.push(JSON.parse(init.body));
    return new Response(JSON.stringify(providerResponse(format)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  const result = await callLlm(
    {
      apiBaseUrl: 'http://x', apiKey: 'k', model: 'm', apiFormat: format,
      forceToolChoice: { name: 'send_message' },
      ...(opts.support ? { forceToolChoiceSupport: opts.support } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(opts.needsForcedOutput ? { needsForcedOutput: true } : {}),
    } as never,
    entries, 'sys', tools as never, { log, label: 't', dumpId: 'd' } as never,
  );
  vi.unstubAllGlobals();
  return { body: captured[0], forceApplied: result.forceApplied };
};

const names = (body: any) => (body.tools ?? []).map((t: any) => t.name ?? t.function?.name);

describe('forceToolChoiceSupport', () => {
  it('full names the tool and keeps every schema', async () => {
    const { body, forceApplied } = await capture({ support: 'full' });
    expect(names(body)).toEqual(['send_message', 'bash']);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'send_message' });
    expect(forceApplied).toBe(true);
  });

  it('defaults to full', async () => {
    const { body } = await capture({});
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'send_message' });
  });

  it('anyToolOnly narrows to one tool and asks for any', async () => {
    const { body, forceApplied } = await capture({ support: 'anyToolOnly' });
    expect(names(body)).toEqual(['send_message']);
    expect(body.tool_choice).toEqual({ type: 'any' });
    expect(forceApplied).toBe(true);
  });

  it('none leaves the request unconstrained so the model keeps its reasoning', async () => {
    const { body, forceApplied } = await capture({ support: 'none', reasoningEffort: 'high' });
    expect(names(body)).toEqual(['send_message', 'bash']);
    expect(body.tool_choice).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(forceApplied).toBe(false);
  });

  it('reasoningDisabledOnly prefers reasoning on ordinary calls', async () => {
    const { body, forceApplied } = await capture({ support: 'reasoningDisabledOnly', reasoningEffort: 'high' });
    expect(body.tool_choice).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(forceApplied).toBe(false);
  });

  it('reasoningDisabledOnly forces only the last-resort call, turning reasoning off', async () => {
    const { body, forceApplied } = await capture({
      support: 'reasoningDisabledOnly', reasoningEffort: 'high', needsForcedOutput: true,
    });
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'send_message' });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).toBeUndefined();
    expect(forceApplied).toBe(true);
  });

  it('renders reasoning effort per protocol', async () => {
    const openai = (await capture({ support: 'none', reasoningEffort: 'low', format: 'openai-chat' })).body;
    expect(openai.reasoning_effort).toBe('low');
    expect(openai.tool_choice).toBeUndefined();

    const responses = (await capture({ support: 'none', reasoningEffort: 'low', format: 'responses' })).body;
    expect(responses.reasoning).toEqual({ effort: 'low' });
    expect(responses.tool_choice).toBeUndefined();
  });

  it('merges effort into reasoning knobs that extraBody already carries', async () => {
    const captured: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      captured.push(JSON.parse(init.body));
      return new Response(JSON.stringify(providerResponse('responses')), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await callLlm(
      {
        apiBaseUrl: 'http://x', apiKey: 'k', model: 'm', apiFormat: 'responses',
        reasoningEffort: 'medium',
        extraBody: { reasoning: { summary: 'detailed' } },
      } as never,
      entries, 'sys', tools as never, { log, label: 't', dumpId: 'd' } as never,
    );
    vi.unstubAllGlobals();
    expect(captured[0].reasoning).toEqual({ summary: 'detailed', effort: 'medium' });
  });

  it('omits reasoning entirely when no effort is configured', async () => {
    const { body } = await capture({ support: 'none' });
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });
});
