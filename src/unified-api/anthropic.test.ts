import { describe, expect, it } from 'vitest';

import type { MessagesAssistantContentBlock, MessagesToolResultBlock } from './anthropic-types';
import { fromMessagesOutput } from './from-messages-output';
import { toMessagesInput } from './to-messages-input';
import type { ConversationEntry, OutputMessage } from './types';

describe('fromMessagesOutput', () => {
  it('converts text blocks', () => {
    const result = fromMessagesOutput([{ type: 'text', text: 'Hello world' }]);
    expect(result).toHaveLength(1);
    const msg = result[0] as OutputMessage;
    expect(msg.kind).toBe('message');
    expect(msg.role).toBe('assistant');
    expect(msg.parts).toEqual([{ kind: 'text', text: 'Hello world' }]);
  });

  it('converts thinking blocks to ReasoningPart', () => {
    const blocks: MessagesAssistantContentBlock[] = [
      { type: 'thinking', thinking: 'Let me think...', signature: 'sig123' },
      { type: 'text', text: 'The answer is 42' },
    ];
    const msg = fromMessagesOutput(blocks)[0] as OutputMessage;
    expect(msg.parts).toHaveLength(2);
    expect(msg.parts[0]).toEqual({
      kind: 'reasoning',
      data: {
        source: 'anthropicMessages',
        data: { type: 'thinking', thinking: 'Let me think...', signature: 'sig123' },
      },
    });
    expect(msg.parts[1]).toEqual({ kind: 'text', text: 'The answer is 42' });
  });

  it('converts redacted_thinking blocks', () => {
    const msg = fromMessagesOutput([
      { type: 'redacted_thinking', data: 'opaque_data_here' },
      { type: 'text', text: 'Result' },
    ])[0] as OutputMessage;
    expect(msg.parts[0]).toEqual({
      kind: 'reasoning',
      data: {
        source: 'anthropicMessages',
        data: { type: 'redacted_thinking', data: 'opaque_data_here' },
      },
    });
  });

  it('converts tool_use blocks', () => {
    const msg = fromMessagesOutput([
      { type: 'tool_use', id: 'tu_123', name: 'get_weather', input: { city: 'Paris' } },
    ])[0] as OutputMessage;
    expect(msg.parts).toEqual([{
      kind: 'toolCall',
      callId: 'tu_123',
      name: 'get_weather',
      args: '{"city":"Paris"}',
    }]);
  });

  it('preserves extra fields on tool_use', () => {
    const msg = fromMessagesOutput([
      { type: 'tool_use', id: 'tu_1', name: 'fn', input: {}, cache_control: { type: 'ephemeral' } },
    ])[0] as OutputMessage;
    const seg = msg.parts[0] as { extra?: { source: string; fields: Record<string, unknown> } };
    expect(seg.extra).toEqual({
      source: 'anthropicMessages',
      fields: { cache_control: { type: 'ephemeral' } },
    });
  });
});

describe('toMessagesInput', () => {
  it('extracts system messages to top-level parameter', async () => {
    const entries: ConversationEntry[] = [
      { kind: 'message', role: 'system', parts: [{ kind: 'text', text: 'You are helpful.' }] },
      { kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'Hi' }] },
    ];
    const { system, messages } = await toMessagesInput(entries);
    expect(system).toBe('You are helpful.');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
  });

  it('merges consecutive tool results into user message', async () => {
    const entries: ConversationEntry[] = [
      { kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'Do stuff' }] },
      {
        kind: 'message', role: 'assistant', parts: [
          { kind: 'toolCall', callId: 'tc1', name: 'fn1', args: '{}' },
          { kind: 'toolCall', callId: 'tc2', name: 'fn2', args: '{}' },
        ], reasoning: undefined,
      },
      { kind: 'toolResult', callId: 'tc1', payload: 'result1', requiresFollowUp: true },
      { kind: 'toolResult', callId: 'tc2', payload: 'result2', requiresFollowUp: false },
    ];
    const { messages } = await toMessagesInput(entries);
    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe('user');
    expect(messages[1]!.role).toBe('assistant');
    const assistantContent = messages[1]!.content as MessagesAssistantContentBlock[];
    expect(assistantContent).toHaveLength(2);
    expect(assistantContent.every(b => b.type === 'tool_use')).toBe(true);
    expect(messages[2]!.role).toBe('user');
    const userContent = messages[2]!.content as MessagesToolResultBlock[];
    expect(userContent).toHaveLength(2);
    expect(userContent.every(b => b.type === 'tool_result')).toBe(true);
  });

  it('round-trips thinking blocks', async () => {
    const originalBlocks: MessagesAssistantContentBlock[] = [
      { type: 'thinking', thinking: 'Deep thought', signature: 'abc123' },
      { type: 'text', text: 'Answer' },
    ];
    const unified = fromMessagesOutput(originalBlocks);
    const { messages } = await toMessagesInput(unified);
    const content = messages[0]!.content as MessagesAssistantContentBlock[];
    expect(content[0]).toEqual({ type: 'thinking', thinking: 'Deep thought', signature: 'abc123' });
    expect(content[1]).toEqual({ type: 'text', text: 'Answer' });
  });

  it('converts Chat message-level reasoning to thinking block', async () => {
    const entries: ConversationEntry[] = [
      {
        kind: 'message', role: 'assistant',
        parts: [{ kind: 'text', text: 'Answer' }],
        reasoning: { reasoning_content: 'I thought about it', reasoning_opaque: 'sig_xyz' },
      },
    ];
    const { messages } = await toMessagesInput(entries);
    const content = messages[0]!.content as MessagesAssistantContentBlock[];
    expect(content).toHaveLength(2);
    expect(content[0]!.type).toBe('thinking');
    expect((content[0] as { thinking: string }).thinking).toBe('I thought about it');
    expect((content[0] as Record<string, unknown>).signature).toBe('sig_xyz');
    expect(content[1]).toEqual({ type: 'text', text: 'Answer' });
  });

  it('converts reasoning_opaque only to redacted_thinking block', async () => {
    const entries: ConversationEntry[] = [
      {
        kind: 'message', role: 'assistant',
        parts: [{ kind: 'text', text: 'Answer' }],
        reasoning: { reasoning_opaque: 'opaque_only' },
      },
    ];
    const { messages } = await toMessagesInput(entries);
    const content = messages[0]!.content as MessagesAssistantContentBlock[];
    expect(content[0]).toEqual({ type: 'redacted_thinking', data: 'opaque_only' });
  });

  it('throws on non-text system parts', async () => {
    const entries: ConversationEntry[] = [
      {
        kind: 'message', role: 'system',
        parts: [{ kind: 'image' } as never],
      },
    ];
    await expect(toMessagesInput(entries)).rejects.toThrow(/System message parts must be text/);
  });

  it('normalizes Responses-sourced opaque-only reasoning to redacted_thinking', async () => {
    const entries: ConversationEntry[] = [
      {
        kind: 'message', role: 'assistant',
        parts: [
          {
            kind: 'reasoning',
            data: {
              source: 'openaiResponses',
              data: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque_blob' },
            },
          },
        ],
        reasoning: undefined,
      },
    ];
    const { messages } = await toMessagesInput(entries);
    const content = messages[0]!.content as MessagesAssistantContentBlock[];
    expect(content[0]).toEqual({ type: 'redacted_thinking', data: 'opaque_blob' });
  });

  it('preserves extra on reasoning parts through round-trip', () => {
    const blocks: MessagesAssistantContentBlock[] = [
      {
        type: 'thinking',
        thinking: 'hmm',
        signature: 'sig',
        cache_control: { type: 'ephemeral' },
      } as MessagesAssistantContentBlock,
    ];
    const msg = fromMessagesOutput(blocks)[0] as OutputMessage;
    const seg = msg.parts[0] as { extra?: { source: string; fields: Record<string, unknown> } };
    expect(seg.extra).toEqual({
      source: 'anthropicMessages',
      fields: { cache_control: { type: 'ephemeral' } },
    });
  });
});

describe('toMessagesInput tool id sanitization', () => {
  it('rewrites disallowed characters and pairs tool_use with tool_result', async () => {
    const entries: ConversationEntry[] = [
      {
        kind: 'message',
        role: 'assistant',
        parts: [{ kind: 'toolCall', callId: 'send_message:103', name: 'send_message', args: '{}' }],
        reasoning: undefined,
      },
      { kind: 'toolResult', callId: 'send_message:103', payload: '{"ok":true}', requiresFollowUp: false },
    ];

    const { messages } = await toMessagesInput(entries);
    const assistant = messages.find(m => m.role === 'assistant')!;
    const user = messages.find(m => m.role === 'user')!;
    const toolUse = (assistant.content as MessagesAssistantContentBlock[]).find(b => b.type === 'tool_use') as { id: string };
    const toolRes = (user.content as MessagesToolResultBlock[]).find(b => b.type === 'tool_result')!;
    expect(toolUse.id).toBe('send_message_103');
    expect(toolRes.tool_use_id).toBe('send_message_103');
  });

  it('deduplicates collisions after sanitization', async () => {
    const entries: ConversationEntry[] = [
      {
        kind: 'message',
        role: 'assistant',
        parts: [
          { kind: 'toolCall', callId: 'a:b', name: 'f', args: '{}' },
          { kind: 'toolCall', callId: 'a?b', name: 'f', args: '{}' },
        ],
        reasoning: undefined,
      },
      { kind: 'toolResult', callId: 'a:b', payload: 'one', requiresFollowUp: false },
      { kind: 'toolResult', callId: 'a?b', payload: 'two', requiresFollowUp: false },
    ];

    const { messages } = await toMessagesInput(entries);
    const assistant = messages.find(m => m.role === 'assistant')!;
    const user = messages.find(m => m.role === 'user')!;
    const toolUses = (assistant.content as MessagesAssistantContentBlock[]).filter(b => b.type === 'tool_use') as Array<{ id: string }>;
    const toolRes = (user.content as MessagesToolResultBlock[]).filter(b => b.type === 'tool_result');
    expect(toolUses.map(tu => tu.id)).toEqual(['a_b', 'a_b_2']);
    expect(toolRes.map(tr => tr.tool_use_id)).toEqual(['a_b', 'a_b_2']);
  });

  it('leaves already-valid ids untouched', async () => {
    const entries: ConversationEntry[] = [
      {
        kind: 'message',
        role: 'assistant',
        parts: [{ kind: 'toolCall', callId: 'toolu_abc123', name: 'f', args: '{}' }],
        reasoning: undefined,
      },
      { kind: 'toolResult', callId: 'toolu_abc123', payload: 'ok', requiresFollowUp: false },
    ];

    const { messages } = await toMessagesInput(entries);
    const assistant = messages.find(m => m.role === 'assistant')!;
    const toolUse = (assistant.content as MessagesAssistantContentBlock[]).find(b => b.type === 'tool_use') as { id: string };
    expect(toolUse.id).toBe('toolu_abc123');
  });
});
