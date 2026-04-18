import { describe, expect, it } from 'vitest';

import {
  appendRecentSendMessageAssessments,
  assessSendMessageHumanLikeness,
  collectRecentSendMessageAssessments,
  renderRecentSendMessageHumanLikenessXml,
} from './send-message-human-likeness';
import type { TurnResponseV2 } from './types';
import type { ConversationEntry } from '../unified-api/types';

const tr = (requestedAtMs: number, entries: ConversationEntry[]): TurnResponseV2 => ({
  requestedAtMs,
  entries,
  inputTokens: 0,
  outputTokens: 0,
  modelName: 'test-model',
});

const sendCall = (callId: string, text: string): ConversationEntry => ({
  kind: 'message',
  role: 'assistant',
  parts: [{ kind: 'toolCall', callId, name: 'send_message', args: JSON.stringify({ text }) }],
  reasoning: undefined,
});

const sendCalls = (calls: Array<{ callId: string; text: string }>): ConversationEntry => ({
  kind: 'message',
  role: 'assistant',
  parts: calls.map(c => ({ kind: 'toolCall', callId: c.callId, name: 'send_message', args: JSON.stringify({ text: c.text }) })),
  reasoning: undefined,
});

const okResult = (callId: string, messageId: string): ConversationEntry => ({
  kind: 'toolResult',
  callId,
  payload: JSON.stringify({ ok: true, message_id: messageId }),
  requiresFollowUp: false,
});

const errResult = (callId: string): ConversationEntry => ({
  kind: 'toolResult',
  callId,
  payload: JSON.stringify({ error: 'boom' }),
  requiresFollowUp: true,
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

  it('collects only successful send_message calls and keeps the latest five', () => {
    const collected = collectRecentSendMessageAssessments([
      tr(1000, [sendCall('tc1', 'one'), okResult('tc1', '1')]),
      tr(2000, [
        sendCalls([{ callId: 'tc2', text: 'two' }, { callId: 'tc3', text: 'ignored' }]),
        okResult('tc2', '2'),
        errResult('tc3'),
      ]),
      tr(3000, [sendCall('fc1', 'three'), okResult('fc1', '3')]),
      tr(4000, [
        sendCalls([{ callId: 'fc2', text: 'four' }, { callId: 'fc3', text: 'five' }]),
        okResult('fc2', '4'),
        okResult('fc3', '5'),
      ]),
      tr(5000, [sendCall('tc4', 'six'), okResult('tc4', '6')]),
    ]);

    expect(collected.map(m => m.text)).toEqual(['two', 'three', 'four', 'five', 'six']);
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
      tr(6000, [sendCall('tc6', 'six'), okResult('tc6', '6')]),
    );

    expect(recent.map(m => m.text)).toEqual(['two', 'three', 'four', 'five', 'six']);
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
