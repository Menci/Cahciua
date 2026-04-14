import { describe, expect, it } from 'vitest';

import { appendRecentSendMessageAssessments, assessSendMessageHumanLikeness, collectRecentSendMessageAssessments, renderRecentSendMessageHumanLikenessXml } from './send-message-human-likeness';
import type { ResponsesTRDataItem, TRDataEntry, TurnResponse } from './types';

const chatTr = (requestedAtMs: number, data: TRDataEntry[]): TurnResponse => ({
  requestedAtMs,
  provider: 'openai-chat',
  data,
  inputTokens: 0,
  outputTokens: 0,
});

const responsesTr = (requestedAtMs: number, data: ResponsesTRDataItem[]): TurnResponse => ({
  requestedAtMs,
  provider: 'responses',
  data,
  inputTokens: 0,
  outputTokens: 0,
});

const sendMessageToolCall = (id: string, text: string) => ({
  id,
  type: 'function' as const,
  function: {
    name: 'send_message',
    arguments: JSON.stringify({ text }),
  },
});

describe('send-message-human-likeness', () => {
  it('detects trailing periods but not ellipses', () => {
    expect(assessSendMessageHumanLikeness('行。')).toEqual(['trailing-period']);
    expect(assessSendMessageHumanLikeness('ok.')).toEqual(['trailing-period']);
    expect(assessSendMessageHumanLikeness('等等...')).toEqual([]);
  });

  it('detects punctuation-heavy short messages without flagging longer explanations', () => {
    expect(assessSendMessageHumanLikeness('我看了下，问题不大，你先别动')).toEqual(['dense-clause-punctuation']);
    expect(assessSendMessageHumanLikeness('这个问题我看了下，应该是上下文拼接顺序有点怪，不过现在先别动，我再收一下日志')).toEqual([]);
  });

  it('detects multiple markdown bold spans only when there are more than one', () => {
    expect(assessSendMessageHumanLikeness('**once** only')).toEqual([]);
    expect(assessSendMessageHumanLikeness('**one** and **two**')).toEqual(['multiple-markdown-bold']);
  });

  it('detects markdown lists, headers, and newlines', () => {
    expect(assessSendMessageHumanLikeness('# Title\n- item')).toEqual([
      'markdown-list',
      'markdown-header',
      'newline',
    ]);
  });

  it('collects only successful send_message calls across providers and keeps the latest five', () => {
    const collected = collectRecentSendMessageAssessments([
      chatTr(1000, [
        { role: 'assistant', tool_calls: [sendMessageToolCall('tc1', 'one')] },
        { role: 'tool', tool_call_id: 'tc1', content: JSON.stringify({ ok: true, message_id: '1' }) },
      ]),
      chatTr(2000, [
        { role: 'assistant', tool_calls: [sendMessageToolCall('tc2', 'two'), sendMessageToolCall('tc3', 'ignored')] },
        { role: 'tool', tool_call_id: 'tc2', content: JSON.stringify({ ok: true, message_id: '2' }) },
        { role: 'tool', tool_call_id: 'tc3', content: JSON.stringify({ error: 'boom' }) },
      ]),
      responsesTr(3000, [
        { type: 'function_call', call_id: 'fc1', name: 'send_message', arguments: JSON.stringify({ text: 'three' }), status: 'completed' },
        { type: 'function_call_output', call_id: 'fc1', output: JSON.stringify({ ok: true, message_id: '3' }) },
      ]),
      responsesTr(4000, [
        { type: 'function_call', call_id: 'fc2', name: 'send_message', arguments: JSON.stringify({ text: 'four' }), status: 'completed' },
        { type: 'function_call', call_id: 'fc3', name: 'send_message', arguments: JSON.stringify({ text: 'five' }), status: 'completed' },
        { type: 'function_call_output', call_id: 'fc2', output: JSON.stringify({ ok: true, message_id: '4' }) },
        { type: 'function_call_output', call_id: 'fc3', output: JSON.stringify({ ok: true, message_id: '5' }) },
      ]),
      chatTr(5000, [
        { role: 'assistant', tool_calls: [sendMessageToolCall('tc4', 'six')] },
        { role: 'tool', tool_call_id: 'tc4', content: JSON.stringify({ ok: true, message_id: '6' }) },
      ]),
    ]);

    expect(collected.map(message => message.text)).toEqual(['two', 'three', 'four', 'five', 'six']);
  });

  it('appends new successful send_message calls into the recent window', () => {
    const recent = appendRecentSendMessageAssessments(
      [
        { text: 'one', features: [] },
        { text: 'two', features: [] },
        { text: 'three', features: [] },
        { text: 'four', features: [] },
        { text: 'five', features: [] },
      ],
      chatTr(6000, [
        { role: 'assistant', tool_calls: [sendMessageToolCall('tc6', 'six')] },
        { role: 'tool', tool_call_id: 'tc6', content: JSON.stringify({ ok: true, message_id: '6' }) },
      ]),
    );

    expect(recent.map(message => message.text)).toEqual(['two', 'three', 'four', 'five', 'six']);
  });

  it('renders xml for both empty and flagged recent messages', () => {
    expect(renderRecentSendMessageHumanLikenessXml([])).toBe('');

    expect(renderRecentSendMessageHumanLikenessXml([
      { text: 'plain', features: [] },
    ])).toBe('');

    const rendered = renderRecentSendMessageHumanLikenessXml([
      { text: '行。', features: ['trailing-period'] },
      { text: '我看了下，问题不大，你先别动', features: ['dense-clause-punctuation'] },
    ]);

    expect(rendered).toContain('checked-count="2"');
    expect(rendered).toContain('<human-likeness');
    expect(rendered).toContain('trailing-period');
    expect(rendered).toContain('dense-clause-punctuation');
    expect(rendered).toContain('<guidance>If those patterns were intentional');
  });
});
