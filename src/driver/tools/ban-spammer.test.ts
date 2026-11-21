import { describe, expect, it, vi } from 'vitest';

import { createBanSpammerTool } from './ban-spammer';
import { decideLinkPreviewOptions } from '../../telegram/link-preview';
import { renderMarkdownToTelegramHTML } from '../../telegram/markdown';
import type { BanSpammerResult } from '../../telegram/moderation-types';

const cleanDeletion = {
  deletedMessageIds: [1],
  unavailableMessageIds: [],
  notDeletableMessageIds: [],
  failedMessageIds: [],
};

const completed: BanSpammerResult = {
  status: 'completed',
  userId: '456',
  ban: { status: 'banned' },
  deletion: cleanDeletion,
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

  it.each<{ label: string; outcome: BanSpammerResult }>([
    {
      label: 'full ban and message deletion',
      outcome: completed,
    },
    {
      label: 'target already left the group',
      outcome: {
        status: 'partial',
        userId: '456',
        ban: { status: 'unresolved' },
        deletion: { ...cleanDeletion, deletedMessageIds: [1, 2] },
      },
    },
    {
      label: 'messages were already deleted',
      outcome: {
        status: 'completed',
        userId: '456',
        ban: { status: 'banned' },
        deletion: { ...cleanDeletion, deletedMessageIds: [], unavailableMessageIds: [1] },
      },
    },
    {
      label: 'both target and messages were already gone',
      outcome: {
        status: 'partial',
        userId: '456',
        ban: { status: 'unresolved' },
        deletion: { ...cleanDeletion, deletedMessageIds: [], unavailableMessageIds: [1] },
      },
    },
  ])('instructs silence without an announcement on $label', async ({ outcome }) => {
    const ban = vi.fn(async () => outcome);
    const result = await createBanSpammerTool(ban).execute({
      message_id: '1',
      reason: 'Private spam content and attacker name',
    });
    const payload = JSON.parse(result.content as string);
    expect(ban).toHaveBeenCalledWith(1);
    expect(result.requiresFollowUp).toBe(true);
    expect(result.content).not.toContain('Private spam content');
    expect(payload).not.toHaveProperty('announcement');
    expect(payload).not.toHaveProperty('account_link');
    expect(payload.next_action).toContain('Do not send any message');
    expect(payload.next_action).toContain('end_turn');
  });

  it.each<{ label: string; outcome: BanSpammerResult }>([
    {
      label: 'missing bot permissions',
      outcome: {
        status: 'partial',
        userId: '456',
        ban: { status: 'missing_permissions' },
        deletion: cleanDeletion,
      },
    },
    {
      label: 'protected target',
      outcome: {
        status: 'partial',
        userId: '456',
        ban: { status: 'protected' },
        deletion: cleanDeletion,
      },
    },
    {
      label: 'message past the 48-hour deletion window',
      outcome: {
        status: 'partial',
        userId: '456',
        ban: { status: 'banned' },
        deletion: { ...cleanDeletion, notDeletableMessageIds: [2] },
      },
    },
    {
      label: 'failed message deletion',
      outcome: {
        status: 'partial',
        userId: '456',
        ban: { status: 'banned' },
        deletion: { ...cleanDeletion, failedMessageIds: [2] },
      },
    },
  ])('supplies an anonymous UID link and confidentiality notice on $label', async ({ outcome }) => {
    const result = await createBanSpammerTool(async () => outcome).execute({
      message_id: '1',
      reason: 'Private spam content',
    });
    const payload = JSON.parse(result.content as string);
    expect(result.requiresFollowUp).toBe(true);
    expect(result.content).not.toContain('Private spam content');
    expect(payload.account_link).toBe('[spam 账号](tg://user?id=456)');
    expect(payload.confidentiality).toContain('Do not repeat the spam message text');
    expect(payload.confidentiality).toContain('sender display name or username');
    expect(payload.next_action).toContain('send_message');
    expect(renderMarkdownToTelegramHTML(payload.account_link)).toContain('<a href="tg://user?id=456">spam 账号</a>');
    expect(decideLinkPreviewOptions('spam 账号', [])).toEqual({ linkPreview: false });
  });

  it('propagates a thrown error with a confidential failureMessage configured', async () => {
    const failure = new Error('Telegram ban failed');
    const tool = createBanSpammerTool(async () => { throw failure; });
    expect(tool.failureMessage).toContain('Do not repeat the spam message text');
    await expect(tool.execute({ message_id: '1', reason: 'spam' })).rejects.toBe(failure);
  });

  it('includes confidentiality guidance without an account link when rejected', async () => {
    const result = await createBanSpammerTool(async () => ({ status: 'rejected', reason: 'message_limit' } as const))
      .execute({ message_id: '1', reason: 'spam' });
    const payload = JSON.parse(result.content as string);
    expect(result.requiresFollowUp).toBe(true);
    expect(payload).not.toHaveProperty('announcement');
    expect(payload).not.toHaveProperty('account_link');
    expect(payload.confidentiality).toContain('Do not repeat the spam message text');
    expect(payload.confidentiality).toContain('sender display name or username');
  });
});
