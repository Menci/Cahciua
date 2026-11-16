import type { Logger } from '@guiiai/logg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createModerationService } from './moderation';
import type { ModerationApi } from './moderation-types';

const CHAT = '-100123';
const USER = '456';
const HASH = '987654321';
const NOW = 1_800_000_000_000;

const fixture = (count = 1) => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const api = {
    resolveAccessHash: vi.fn<ModerationApi['resolveAccessHash']>(async () => HASH),
    inspectMembers: vi.fn<ModerationApi['inspectMembers']>(async () => ({
      canModerate: true,
      status: 'member',
      inputUser: { className: 'InputUser' },
    })),
    inspectMessage: vi.fn<ModerationApi['inspectMessage']>(async () => ({ date: NOW / 1000 - 1 })),
    ban: vi.fn<ModerationApi['ban']>(async () => {}),
    deleteMessage: vi.fn<ModerationApi['deleteMessage']>(async () => {}),
  };
  const findAuthor = vi.fn((chatId: string, messageId: number): { userId: string } | undefined =>
    chatId === CHAT && messageId === 1 ? { userId: USER } : undefined);
  const loadMessageIds = vi.fn(() => Array.from({ length: count }, (_, i) => i + 1));
  const logger = { withContext: vi.fn(), withFields: vi.fn(), withError: vi.fn(), error: vi.fn(), warn: vi.fn() };
  for (const method of [logger.withContext, logger.withFields, logger.withError]) method.mockReturnValue(logger);
  const publishDeletions = vi.fn();
  const deps = {
    api, findAuthor, loadMessageIds,
    botUserId: '999', enabledChatIds: new Set([CHAT, '-100987']), publishDeletions,
    logger: logger as unknown as Logger,
  };
  const service = createModerationService(deps);
  return { ...deps, service, restart: () => createModerationService(deps) };
};

afterEach(() => vi.useRealTimers());

describe('spam moderation', () => {
  it('rejects disabled chats before any API call or archive lookup', async () => {
    const f = fixture();
    f.enabledChatIds.delete(CHAT);
    expect(await f.service.banSpammer(CHAT, 1)).toEqual({ status: 'rejected', reason: 'disabled_chat' });
    expect(f.findAuthor).not.toHaveBeenCalled();
    expect(f.api.resolveAccessHash).not.toHaveBeenCalled();
    expect(f.api.ban).not.toHaveBeenCalled();
  });

  it.each([1, 9])('allows %i messages and publishes actual deletions', async count => {
    const f = fixture(count);
    const result = await f.service.banSpammer(CHAT, 1);
    expect(result).toMatchObject({ status: 'completed', banned: true });
    expect(f.api.ban).toHaveBeenCalledExactlyOnceWith(CHAT, expect.objectContaining({ userId: USER }));
    expect(f.api.deleteMessage).toHaveBeenCalledTimes(count);
    expect(f.publishDeletions).toHaveBeenCalledWith(CHAT, Array.from({ length: count }, (_, i) => i + 1));
  });

  it.each([0, 10, 11])('refuses %i observed messages without any mutation', async count => {
    const f = fixture(count);
    expect(await f.service.banSpammer(CHAT, 1)).toEqual({ status: 'rejected', reason: 'message_limit' });
    expect(f.api.ban).not.toHaveBeenCalled();
    expect(f.api.deleteMessage).not.toHaveBeenCalled();
  });

  it('counts new messages arriving during asynchronous preflight', async () => {
    const f = fixture(9);
    f.api.inspectMembers.mockImplementation(async () => {
      f.loadMessageIds.mockReturnValue(Array.from({ length: 10 }, (_, i) => i + 1));
      return { canModerate: true, status: 'member', inputUser: {} };
    });
    expect(await f.service.banSpammer(CHAT, 1)).toMatchObject({ reason: 'message_limit' });
    expect(f.api.ban).not.toHaveBeenCalled();
  });

  it.each(['-100987', '-100777', '123'])('cannot target a message in another chat (%s)', async chatId => {
    const f = fixture();
    expect((await f.service.banSpammer(chatId, 1)).status).toBe('rejected');
    expect(f.api.ban).not.toHaveBeenCalled();
  });

  it.each(['999', '-100123', 'invalid'])('protects self and non-user identities (%s)', async userId => {
    const f = fixture();
    f.findAuthor.mockReturnValue({ userId });
    expect(await f.service.banSpammer(CHAT, 1)).toMatchObject({ reason: 'protected_user' });
    expect(f.api.resolveAccessHash).not.toHaveBeenCalled();
    expect(f.api.inspectMembers).not.toHaveBeenCalled();
  });

  it('protects owners and administrators', async () => {
    const f = fixture();
    f.api.inspectMembers.mockResolvedValue({ canModerate: true, status: 'protected', inputUser: {} });
    expect(await f.service.banSpammer(CHAT, 1)).toMatchObject({ reason: 'protected_user' });
    expect(f.api.ban).not.toHaveBeenCalled();
  });

  it.each(['left', 'banned'] as const)('bans an account with %s membership', async status => {
    const f = fixture();
    f.api.inspectMembers.mockResolvedValue({ canModerate: true, status, inputUser: {} });
    expect(await f.service.banSpammer(CHAT, 1)).toMatchObject({ status: 'completed', banned: true });
    expect(f.api.ban).toHaveBeenCalledWith(CHAT, expect.objectContaining({ userId: USER }));
  });

  it('requires both ban and delete permissions before any action', async () => {
    const f = fixture();
    f.api.inspectMembers.mockResolvedValue({ canModerate: false, status: 'member', inputUser: {} });
    expect(await f.service.banSpammer(CHAT, 1)).toMatchObject({ reason: 'missing_permissions' });
    expect(f.api.ban).not.toHaveBeenCalled();
  });

  it('bans using the archive alone, so a deleted evidence message is irrelevant', async () => {
    const f = fixture();
    f.api.inspectMessage.mockResolvedValue(undefined);
    expect(await f.service.banSpammer(CHAT, 1)).toMatchObject({ status: 'completed', banned: true });
    expect(f.api.ban).toHaveBeenCalledWith(CHAT, expect.objectContaining({ userId: USER }));
  });

  it('resolves the access hash live and uses it for the ban', async () => {
    const f = fixture();
    expect(await f.service.banSpammer(CHAT, 1)).toMatchObject({ status: 'completed', banned: true });
    expect(f.api.resolveAccessHash).toHaveBeenCalledWith(CHAT, USER);
    expect(f.api.inspectMembers).toHaveBeenCalledWith(CHAT, { userId: USER, accessHash: HASH });
  });

  it('rejects when the target cannot be resolved through the bot session', async () => {
    const f = fixture();
    f.api.resolveAccessHash.mockResolvedValue(undefined);
    expect(await f.service.banSpammer(CHAT, 1)).toMatchObject({ reason: 'unresolved_target' });
    expect(f.api.ban).not.toHaveBeenCalled();
    expect(f.api.deleteMessage).not.toHaveBeenCalled();
  });

  it('propagates ban failures before deleting anything', async () => {
    const f = fixture();
    const failure = new Error('network failure');
    f.api.ban.mockRejectedValue(failure);
    await expect(f.service.banSpammer(CHAT, 1)).rejects.toBe(failure);
    expect(f.api.deleteMessage).not.toHaveBeenCalled();
  });

  it('rechecks current messages on a repeated call after partial deletion', async () => {
    const f = fixture(2);
    f.api.deleteMessage.mockImplementation(async (_chatId, id) => { if (id === 2) throw new Error('network failure'); });
    expect(await f.service.banSpammer(CHAT, 1)).toMatchObject({ status: 'partial', banned: true, deletedMessageIds: [1], failedMessageIds: [2] });
    f.api.inspectMembers.mockResolvedValue({ canModerate: true, status: 'banned', inputUser: {} });
    f.api.inspectMessage.mockImplementation(async (_chatId, id) => id === 1 ? undefined : { date: NOW / 1000 - 1 });
    f.api.deleteMessage.mockResolvedValue();
    expect(await f.restart().banSpammer(CHAT, 1)).toMatchObject({ status: 'completed', deletedMessageIds: [2], unavailableMessageIds: [1] });
    expect(f.api.deleteMessage.mock.calls.map(call => call[1])).toEqual([1, 2, 2]);
    expect(f.publishDeletions).toHaveBeenLastCalledWith(CHAT, [2, 1]);
  });

  it('distinguishes old and unavailable messages from deletions', async () => {
    const f = fixture(3);
    f.api.inspectMessage.mockImplementation(async (_chatId, id) =>
      id === 2 ? undefined : { date: NOW / 1000 - (id === 3 ? 172800 : 1) });
    expect(await f.service.banSpammer(CHAT, 1)).toMatchObject({
      status: 'partial', banned: true, deletedMessageIds: [1], unavailableMessageIds: [2], notDeletableMessageIds: [3], failedMessageIds: [],
    });
    expect(f.api.deleteMessage).toHaveBeenCalledExactlyOnceWith(CHAT, 1);
    expect(f.publishDeletions).toHaveBeenCalledWith(CHAT, [1, 2]);
  });
});
