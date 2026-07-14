import { describe, expect, it } from 'vitest';

import { applyAnthropicCachePoints } from './messages';
import type { MessagesMessage } from '../unified-api/anthropic-types';

const CACHE_1H = { type: 'ephemeral', ttl: '1h' };

describe('applyAnthropicCachePoints', () => {
  it('wraps system into a text block with 1h cache_control', () => {
    const { system } = applyAnthropicCachePoints('You are helpful.', []);
    expect(system).toEqual([{ type: 'text', text: 'You are helpful.', cache_control: CACHE_1H }]);
  });

  it('omits system when input is undefined', () => {
    const { system } = applyAnthropicCachePoints(undefined, []);
    expect(system).toBeUndefined();
  });

  it('tags last block of second-to-last message and leaves last message untouched', () => {
    const messages: MessagesMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'history' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply A' }, { type: 'text', text: 'reply B' }] },
      { role: 'user', content: [{ type: 'text', text: 'late-binding (volatile)' }] },
    ];
    const { messages: out } = applyAnthropicCachePoints('sys', messages);
    const second = out[1]!.content as Record<string, unknown>[];
    expect(second[0]).toEqual({ type: 'text', text: 'reply A' });
    expect(second[1]).toEqual({ type: 'text', text: 'reply B', cache_control: CACHE_1H });
    const last = out[2]!.content as Record<string, unknown>[];
    expect(last[0]).toEqual({ type: 'text', text: 'late-binding (volatile)' });
    expect(last[0]).not.toHaveProperty('cache_control');
  });

  it('does not mutate caller input', () => {
    const targetBlock = { type: 'text' as const, text: 'block' };
    const messages: MessagesMessage[] = [
      { role: 'user', content: [targetBlock] },
      { role: 'assistant', content: [{ type: 'text', text: 'last' }] },
    ];
    applyAnthropicCachePoints('sys', messages);
    expect(targetBlock).toEqual({ type: 'text', text: 'block' });
    expect(messages[0]!.content).toEqual([{ type: 'text', text: 'block' }]);
    expect(messages[0]!.content === targetBlock as unknown).toBe(false);
  });

  it('skips message tagging when only one message is present', () => {
    const messages: MessagesMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'lonely' }] },
    ];
    const { messages: out } = applyAnthropicCachePoints('sys', messages);
    const block = (out[0]!.content as Record<string, unknown>[])[0]!;
    expect(block).not.toHaveProperty('cache_control');
  });

  it('skips message tagging when target message has empty content array', () => {
    const messages: MessagesMessage[] = [
      { role: 'user', content: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'last' }] },
    ];
    const { messages: out } = applyAnthropicCachePoints('sys', messages);
    expect(out[0]!.content).toEqual([]);
  });

  it('skips message tagging when target message has string content', () => {
    const messages: MessagesMessage[] = [
      { role: 'user', content: 'plain string' },
      { role: 'assistant', content: [{ type: 'text', text: 'last' }] },
    ];
    const { messages: out } = applyAnthropicCachePoints('sys', messages);
    expect(out[0]!.content).toBe('plain string');
  });
});
