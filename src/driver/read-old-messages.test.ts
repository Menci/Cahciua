import { describe, expect, it } from 'vitest';

import { renderOldMessagesXml } from './read-old-messages';
import type { PipelineEvent } from '../projection';

const message = (id: string, text: string, at: number): PipelineEvent => ({
  type: 'message',
  chatId: 'chat',
  messageId: id,
  receivedAtMs: at,
  timestampSec: at / 1000,
  utcOffsetMin: 0,
  content: [{ type: 'text', text }],
  attachments: [],
});

describe('renderOldMessagesXml', () => {
  it('renders the loaded messages in the canonical chatlog XML', () => {
    const xml = renderOldMessagesXml('chat', [message('1', 'hello', 1000), message('2', 'world', 2000)], {});
    expect(xml).toContain('<message id="1"');
    expect(xml).toContain('hello');
    expect(xml).toContain('<message id="2"');
    expect(xml).toContain('world');
  });

  it('reuses the block list, masking blocked senders like the live context', () => {
    const fromBan = { id: 'u1', displayName: 'Spammer', isBot: false };
    const event: PipelineEvent = {
      ...message('1', 'buy now', 1000) as Extract<PipelineEvent, { type: 'message' }>,
      sender: fromBan,
    };
    const xml = renderOldMessagesXml('chat', [event], {}, { blockedUserIds: new Set(['u1']) });
    expect(xml).toContain('blocked="true"');
    expect(xml).not.toContain('buy now');
  });

  it('marks deleted messages instead of exposing their content', () => {
    const del: PipelineEvent = {
      type: 'delete', chatId: 'chat', messageIds: ['1'], receivedAtMs: 2000, timestampSec: 2, utcOffsetMin: 0,
    };
    const xml = renderOldMessagesXml('chat', [message('1', 'secret', 1000), del], {});
    expect(xml).toContain('deleted="true"');
    expect(xml).not.toContain('secret');
  });
});
