import type { Client } from 'tdl';
import { describe, expect, it, vi } from 'vitest';

import { createModerationApi } from './moderation-api';

const fixture = () => {
  const invoke = vi.fn();
  return { invoke, api: createModerationApi({ invoke } as unknown as Pick<Client, 'invoke'>, '999') };
};

describe('bot moderation TDLib boundary', () => {
  it('loads server message IDs into the bot cache and checks deletion properties', async () => {
    const { api, invoke } = fixture();
    invoke.mockResolvedValueOnce({ messages: [{ id: 7 * 1048576, sender_id: { _: 'messageSenderUser', user_id: 456 }, date: 100 }] });
    invoke.mockResolvedValueOnce({ can_be_deleted_for_all_users: true });
    expect(await api.inspectMessage('-100123', 7)).toEqual({ senderId: '456', date: 100, canDelete: true });
    expect(invoke.mock.calls).toEqual([
      [{ _: 'getMessages', chat_id: -100123, message_ids: [7 * 1048576] }],
      [{ _: 'getMessageProperties', chat_id: -100123, message_id: 7 * 1048576 }],
    ]);
  });

  it('distinguishes missing messages from transport failures', async () => {
    const { api, invoke } = fixture();
    invoke.mockResolvedValueOnce({ messages: [null] });
    expect(await api.inspectMessage('-100123', 7)).toBeUndefined();
    const error = new Error('network down');
    invoke.mockRejectedValueOnce(error);
    await expect(api.inspectMessage('-100123', 7)).rejects.toBe(error);
  });

  it('bans permanently and deletes by verified message ID without userbot-only methods', async () => {
    const { api, invoke } = fixture();
    invoke.mockResolvedValue({ _: 'ok' });
    await api.ban('-100123', '456');
    await api.deleteMessage('-100123', 7);
    expect(invoke.mock.calls).toEqual([
      [{ _: 'banChatMember', chat_id: -100123, member_id: { _: 'messageSenderUser', user_id: 456 }, banned_until_date: 0, revoke_messages: true }],
      [{ _: 'deleteMessages', chat_id: -100123, message_ids: [7 * 1048576], revoke: true }],
    ]);
  });

  it.each(['chatMemberStatusCreator', 'chatMemberStatusAdministrator', 'chatMemberStatusLeft'])('protects target status %s', async status => {
    const { api, invoke } = fixture();
    invoke.mockResolvedValueOnce({ type: { _: 'chatTypeSupergroup', is_channel: false } });
    invoke.mockResolvedValueOnce({ status: { _: 'chatMemberStatusAdministrator', rights: { can_restrict_members: true, can_delete_messages: true } } });
    invoke.mockResolvedValueOnce({ status: { _: status } });
    expect(await api.inspectMembers('-100123', '456')).toEqual({ canModerate: true, targetStatus: 'protected' });
  });

  it.each([
    { can_restrict_members: false, can_delete_messages: true },
    { can_restrict_members: true, can_delete_messages: false },
  ])('requires both administrator permissions (%j)', async rights => {
    const { api, invoke } = fixture();
    invoke.mockResolvedValueOnce({ type: { _: 'chatTypeSupergroup', is_channel: false } });
    invoke.mockResolvedValueOnce({ status: { _: 'chatMemberStatusAdministrator', rights } });
    invoke.mockResolvedValueOnce({ status: { _: 'chatMemberStatusMember' } });
    expect(await api.inspectMembers('-100123', '456')).toEqual({ canModerate: false, targetStatus: 'member' });
  });

  it('refuses channels even though they share the supergroup ID format', async () => {
    const { api, invoke } = fixture();
    invoke.mockResolvedValueOnce({ type: { _: 'chatTypeSupergroup', is_channel: true } });
    await expect(api.inspectMembers('-100123', '456')).rejects.toThrow('requires a supergroup');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
