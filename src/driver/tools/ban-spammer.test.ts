import { describe, expect, it, vi } from 'vitest';

import { createBanSpammerTool } from './ban-spammer';
import { decideLinkPreviewOptions } from '../../telegram/link-preview';
import { renderMarkdownToTelegramHTML } from '../../telegram/markdown';
import type { BanSpammerResult } from '../../telegram/moderation-types';

const completed: BanSpammerResult = {
  status: 'completed', userId: '456', banned: true, deletedMessageIds: [1], unavailableMessageIds: [],
  notDeletableMessageIds: [], failedMessageIds: [],
};

describe('ban_spammer tool', () => {
  it('accepts only a message ID and an audit reason', () => {
    const tool = createBanSpammerTool(vi.fn());
    expect(tool.validate({ message_id: '1', reason: 'spam' }).valid).toBe(true);
    for (const input of [
      { message_id: '0', reason: 'spam' },
      { message_id: '1.5', reason: 'spam' },
      { message_id: '1', reason: '' },
      { message_id: '1', reason: 'spam', user_id: '456' },
      { message_id: '1', reason: 'spam', chat_id: '-100999' },
    ]) expect(tool.validate(input).valid).toBe(false);
  });

  it('returns a fixed anonymous audit link and requires a follow-up send', async () => {
    const ban = vi.fn(async () => completed);
    const result = await createBanSpammerTool(ban).execute({ message_id: '1', reason: 'Private spam content and attacker name' });
    const payload = JSON.parse(result.content as string);
    expect(ban).toHaveBeenCalledWith(1);
    expect(result.requiresFollowUp).toBe(true);
    expect(payload.announcement).toBe('已踢出并永久封禁 [spam 账号](tg://user?id=456)，已清理记录中可删除的消息。');
    expect(result.content).not.toContain('Private spam content');
    expect(payload.next_action).toContain('exactly as provided');
    expect(payload.next_action).toContain('exactly one argument: text');
    expect(renderMarkdownToTelegramHTML(payload.announcement)).toContain('<a href="tg://user?id=456">spam 账号</a>');
    expect(decideLinkPreviewOptions('spam 账号', [{
      _: 'textEntity', offset: 0, length: 7, type: { _: 'textEntityTypeTextUrl', url: 'tg://user?id=456' },
    }])).toEqual({ _: 'linkPreviewOptions', is_disabled: true });
  });

  it('announces partial deletion truthfully after a successful ban', async () => {
    const result = await createBanSpammerTool(async () => ({ ...completed, status: 'partial', notDeletableMessageIds: [2] }))
      .execute({ message_id: '1', reason: 'spam' });
    expect(JSON.parse(result.content as string).announcement).toContain('部分消息需人工处理');
  });

  it('propagates a failed ban to the existing tool error handler', async () => {
    const failure = new Error('Telegram ban failed');
    const tool = createBanSpammerTool(async () => { throw failure; });
    await expect(tool.execute({ message_id: '1', reason: 'spam' })).rejects.toBe(failure);
  });

  it.each<BanSpammerResult>([
    { status: 'rejected', reason: 'message_limit' },
  ])('does not claim to have banned a rejected or failed target', async outcome => {
    const result = await createBanSpammerTool(async () => outcome).execute({ message_id: '1', reason: 'spam' });
    expect(JSON.parse(result.content as string)).not.toHaveProperty('announcement');
    expect(result.requiresFollowUp).toBe(true);
  });
});
