import { describe, expect, it } from 'vitest';
import type { Message } from 'xsai';

import { chatTRToResponsesInput, messagesToResponsesInput, responsesOutputToMessages } from './convert';
import type { TRDataEntry } from './types';

type AnyMsg = Record<string, any>;

describe('responsesOutputToMessages', () => {
  it('converts message items to assistant messages', () => {
    const items = [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
    ];
    const result = responsesOutputToMessages(items);
    expect(result).toEqual([
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('converts function_call items to assistant tool_calls', () => {
    const items = [
      { type: 'function_call', call_id: 'fc1', name: 'send_message', arguments: '{"text":"hi"}', status: 'completed' },
    ];
    const result = responsesOutputToMessages(items);
    expect(result).toHaveLength(1);
    const msg = result[0] as AnyMsg;
    expect(msg.role).toBe('assistant');
    expect(msg.tool_calls).toEqual([{
      id: 'fc1', type: 'function', function: { name: 'send_message', arguments: '{"text":"hi"}' },
    }]);
  });

  it('converts function_call_output items to tool messages', () => {
    const items = [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
      { type: 'function_call', call_id: 'fc1', name: 'send_message', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'fc1', output: '{"ok":true}' },
    ];
    const result = responsesOutputToMessages(items);
    expect(result).toHaveLength(2);
    // First: assistant with content + tool_calls
    expect((result[0] as AnyMsg).role).toBe('assistant');
    expect((result[0] as AnyMsg).tool_calls).toHaveLength(1);
    // Second: tool result
    expect((result[1] as AnyMsg).role).toBe('tool');
    expect((result[1] as AnyMsg).tool_call_id).toBe('fc1');
    expect((result[1] as AnyMsg).content).toBe('{"ok":true}');
  });

  it('preserves reasoning when present', () => {
    const items = [
      {
        type: 'reasoning', id: 'rs1',
        summary: [{ type: 'summary_text', text: 'thinking about it' }],
        encrypted_content: 'opaque_blob_123',
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ];
    const result = responsesOutputToMessages(items);
    expect(result).toHaveLength(1);
    const msg = result[0] as AnyMsg;
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('answer');
    expect(msg.reasoning_opaque).toBe('opaque_blob_123');
    expect(msg.reasoning_text).toBe('thinking about it');
  });

  it('handles full tool loop: reasoning + message + function_call + function_call_output', () => {
    const items = [
      { type: 'reasoning', id: 'rs1', summary: [], encrypted_content: 'sig1' },
      { type: 'message', role: 'assistant', content: [] },
      { type: 'function_call', call_id: 'fc1', name: 'send_message', arguments: '{"text":"hi"}', status: 'completed' },
      { type: 'function_call_output', call_id: 'fc1', output: '{"ok":true}' },
      { type: 'reasoning', id: 'rs2', summary: [], encrypted_content: 'sig2' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    ];
    const result = responsesOutputToMessages(items);
    expect(result).toHaveLength(3);
    // assistant(tool_calls + reasoning)
    expect((result[0] as AnyMsg).role).toBe('assistant');
    expect((result[0] as AnyMsg).tool_calls).toHaveLength(1);
    expect((result[0] as AnyMsg).reasoning_opaque).toBe('sig1');
    // tool result
    expect((result[1] as AnyMsg).role).toBe('tool');
    expect((result[1] as AnyMsg).tool_call_id).toBe('fc1');
    // assistant(content + reasoning)
    expect((result[2] as AnyMsg).role).toBe('assistant');
    expect((result[2] as AnyMsg).content).toBe('done');
    expect((result[2] as AnyMsg).reasoning_opaque).toBe('sig2');
  });

  it('handles refusal blocks', () => {
    const items = [
      { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot do that' }] },
    ];
    const result = responsesOutputToMessages(items);
    expect((result[0] as AnyMsg).content).toBe('I cannot do that');
  });
});

describe('chatTRToResponsesInput', () => {
  it('converts assistant text to message with output_text', () => {
    const entries: TRDataEntry[] = [{ role: 'assistant', content: 'hello' }];
    const result = chatTRToResponsesInput(entries);
    expect(result).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
    ]);
  });

  it('converts tool_calls to function_call items', () => {
    const entries: TRDataEntry[] = [{
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'send_message', arguments: '{}' } }],
    }];
    const result = chatTRToResponsesInput(entries);
    expect(result).toEqual([
      { type: 'function_call', call_id: 'tc1', name: 'send_message', arguments: '{}', status: 'completed' },
    ]);
  });

  it('converts tool results to function_call_output items', () => {
    const entries: TRDataEntry[] = [{ role: 'tool', tool_call_id: 'tc1', content: '{"ok":true}' }];
    const result = chatTRToResponsesInput(entries);
    expect(result).toEqual([
      { type: 'function_call_output', call_id: 'tc1', output: '{"ok":true}' },
    ]);
  });

  it('preserves reasoning when present', () => {
    const entries: TRDataEntry[] = [{
      role: 'assistant',
      content: 'answer',
      reasoning_text: 'thinking...',
      reasoning_opaque: 'sig_abc',
    }];
    const result = chatTRToResponsesInput(entries);
    expect(result).toHaveLength(2);
    // reasoning item comes first
    expect(result[0]).toMatchObject({
      type: 'reasoning',
      encrypted_content: 'sig_abc',
      summary: [{ type: 'summary_text', text: 'thinking...' }],
    });
    // then message
    expect(result[1]).toEqual({
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }],
    });
  });

  it('handles full tool loop with reasoning', () => {
    const entries: TRDataEntry[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'fn', arguments: '{}' } }], reasoning_opaque: 'sig1' },
      { role: 'tool', tool_call_id: 'tc1', content: 'ok' },
      { role: 'assistant', content: 'done', reasoning_opaque: 'sig2' },
    ];
    const result = chatTRToResponsesInput(entries);
    expect(result.map(i => i.type)).toEqual([
      'reasoning', 'function_call', 'function_call_output', 'reasoning', 'message',
    ]);
  });
});

describe('messagesToResponsesInput', () => {
  it('converts user text messages', () => {
    const messages = [{ role: 'user', content: 'hello' }] as Message[];
    const result = messagesToResponsesInput(messages);
    expect(result).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
    ]);
  });

  it('converts user messages with content parts', () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'look at this:' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'low' } },
      ],
    }] as Message[];
    const result = messagesToResponsesInput(messages);
    expect(result).toEqual([{
      type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'look at this:' },
        { type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'low' },
      ],
    }]);
  });

  it('preserves reasoning fields on assistant messages', () => {
    const messages = [{
      role: 'assistant',
      content: 'answer',
      reasoning_text: 'thought process',
      reasoning_opaque: 'encrypted_sig',
    }] as unknown as Message[];
    const result = messagesToResponsesInput(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: 'reasoning',
      encrypted_content: 'encrypted_sig',
      summary: [{ type: 'summary_text', text: 'thought process' }],
    });
    expect(result[1]).toEqual({
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }],
    });
  });

  it('converts tool messages to function_call_output', () => {
    const messages = [{ role: 'tool', tool_call_id: 'tc1', content: 'result' }] as unknown as Message[];
    const result = messagesToResponsesInput(messages);
    expect(result).toEqual([
      { type: 'function_call_output', call_id: 'tc1', output: 'result' },
    ]);
  });
});

describe('round-trip fidelity', () => {
  it('responses → chat → responses preserves structure', () => {
    const original = [
      { type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: 'hmm' }], encrypted_content: 'sig1' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
      { type: 'function_call', call_id: 'fc1', name: 'send_message', arguments: '{"text":"hi"}', status: 'completed' },
      { type: 'function_call_output', call_id: 'fc1', output: '{"ok":true}' },
    ];

    const chatMessages = responsesOutputToMessages(original);
    const roundTripped = messagesToResponsesInput(chatMessages);

    // Reasoning preserved
    expect(roundTripped[0]).toMatchObject({
      type: 'reasoning',
      encrypted_content: 'sig1',
      summary: [{ type: 'summary_text', text: 'hmm' }],
    });
    // Function call preserved
    expect(roundTripped).toContainEqual(
      expect.objectContaining({ type: 'function_call', call_id: 'fc1', name: 'send_message' }),
    );
    // Function call output preserved
    expect(roundTripped).toContainEqual(
      expect.objectContaining({ type: 'function_call_output', call_id: 'fc1', output: '{"ok":true}' }),
    );
  });

  it('chat → responses → chat preserves structure', () => {
    const original: TRDataEntry[] = [
      { role: 'assistant', content: 'thinking...', reasoning_text: 'deep thought', reasoning_opaque: 'sig_xyz' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'fn', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tc1', content: 'result' },
    ];

    const responsesItems = chatTRToResponsesInput(original);
    const chatMessages = responsesOutputToMessages(responsesItems);

    // Responses format merges consecutive assistant items (reasoning + message + function_call)
    // into a single assistant message — so 3 entries become 2.
    expect(chatMessages).toHaveLength(2);

    // First: merged assistant with reasoning, content, and tool_calls
    const first = chatMessages[0] as AnyMsg;
    expect(first.role).toBe('assistant');
    expect(first.content).toBe('thinking...');
    expect(first.reasoning_opaque).toBe('sig_xyz');
    expect(first.reasoning_text).toBe('deep thought');
    expect(first.tool_calls).toHaveLength(1);
    expect(first.tool_calls[0].id).toBe('tc1');

    // Second: tool result
    const second = chatMessages[1] as AnyMsg;
    expect(second.role).toBe('tool');
    expect(second.tool_call_id).toBe('tc1');
    expect(second.content).toBe('result');
  });
});
