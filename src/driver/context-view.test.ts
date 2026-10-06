import { describe, expect, it } from 'vitest';

import { composeContext, composeProbeContext, latestExternalEventMs, triggerSenderLatestMs } from './context';
import { selectContextView } from './context-view';
import type { ICMessage, IntermediateContext } from '../projection/types';
import { render, rcToXml } from '../rendering';

const message = (receivedAtMs: number, senderId = 'user'): ICMessage => ({
  type: 'message', messageId: String(receivedAtMs), receivedAtMs,
  timestampSec: receivedAtMs / 1000, utcOffsetMin: 0,
  sender: { id: senderId, displayName: senderId, isBot: false },
  content: [{ type: 'mention', userId: 'bot', children: [{ type: 'text', text: 'secret' }] }],
  replyToMessageId: 'bot-message', replyToSender: { id: 'bot', displayName: 'Bot', isBot: true },
  attachments: [{ type: 'photo', thumbnailWebp: 'aGVsbG8=' }],
});
const context = (nodes: IntermediateContext['nodes']): IntermediateContext => ({ sessionId: 'chat', nodes, users: new Map() });

describe('model context view', () => {
  it('keeps the cursor boundary and service/runtime nodes in original order', () => {
    const base = render(context([
      message(1000),
      { type: 'system_event', kind: 'chat_renamed', oldTitle: null, newTitle: 'New', receivedAtMs: 2000, timestampSec: 2, utcOffsetMin: 0 },
      message(2000),
      { type: 'runtime_event', kind: 'task_completed', taskId: 1, taskType: 'shell', finalSummary: 'Done', hasFullOutput: true, receivedAtMs: 3000, timestampSec: 3, utcOffsetMin: 0 },
    ]));
    const view = selectContextView(base, { cursorMs: 2000 });
    expect(view.map(segment => segment.receivedAtMs)).toEqual([2000, 2000, 3000]);
    expect(rcToXml(view)).toContain('chat_renamed');
    expect(rcToXml(view)).toContain('runtime-event');
    expect(view.at(-1)!.isRuntimeEvent).toBe(true);
    expect(base).toHaveLength(4);
  });

  it('masks content, images and activation flags without losing scheduling identity', () => {
    const base = render(context([message(1000), message(2000, 'other'), message(3000)]), { botUserId: 'bot' });
    expect(base[0]).toMatchObject({ mentionsMe: true, repliesToMe: true });
    const blocked = selectContextView(base, { blockedUserIds: new Set(['user']) });
    expect(blocked[0]).toMatchObject({ senderId: 'user', mentionsMe: undefined, repliesToMe: undefined });
    expect(blocked[0]!.content).toHaveLength(1);
    expect(rcToXml([blocked[0]!])).toBe('<message id="1000" sender="user" t="1970-01-01T00:00:01+00:00" blocked="true"/>');
    expect(latestExternalEventMs(blocked, 0)).toBe(3000);
    expect(triggerSenderLatestMs(blocked, 0)).toBe(3000);
    expect(JSON.stringify(blocked[0])).not.toContain('secret');
    expect(composeContext([blocked[0]!], [], 10000, 'model')!.entries).not.toEqual([]);
    expect(JSON.stringify(composeProbeContext([blocked[0]!], [], 10000))).not.toContain('secret');
    const unblocked = selectContextView(base, {});
    expect(unblocked[0]!.content).toBe(base[0]!.content);
    expect(unblocked[0]!.mentionsMe).toBe(true);
    expect(base[0]!.source).toMatchObject({ messageId: '1000', replyToMessageId: 'bot-message' });
    expect(base[0]!.chatId).toBe('chat');
  });

  it('uses independent policies and budgets without mutating base records', () => {
    const base = render(context([message(1000), message(2000)]));
    const first = selectContextView(base, { cursorMs: 2000, blockedUserIds: new Set(['user']) });
    const second = selectContextView(base, {});
    expect(first).toHaveLength(1);
    expect(rcToXml(first)).not.toContain('secret');
    expect(rcToXml(second)).toContain('secret');
    const contents = base.map(node => node.content);
    composeContext(second, [], 1, 'model', 'earlier');
    composeProbeContext(second, [], 10000, 'different summary');
    expect(base.map(node => node.content)).toEqual(contents);
    expect(base[0]!.content).toBe(contents[0]);
    expect(base[1]!.content).toBe(contents[1]);
  });
});
