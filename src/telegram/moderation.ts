import type { Logger } from '@guiiai/logg';

import type { BanSpammerResult, ModerationApi } from './moderation-types';

const MESSAGE_LIMIT = 10;
const BOT_DELETE_WINDOW_SEC = 48 * 60 * 60;

export const createModerationService = (deps: {
  api: ModerationApi;
  /** Archived author of an evidence message; the only source of the target id. */
  findAuthor: (chatId: string, messageId: number) => { userId: string } | undefined;
  loadMessageIds: (chatId: string, userId: string) => number[];
  botUserId: string;
  enabledChatIds: ReadonlySet<string>;
  publishDeletions: (chatId: string, messageIds: number[]) => void;
  logger: Logger;
}) => {
  const log = deps.logger.withContext('moderation');

  const banSpammer = async (chatId: string, messageId: number): Promise<BanSpammerResult> => {
    if (!deps.enabledChatIds.has(chatId)) return { status: 'rejected', reason: 'disabled_chat' };
    if (!/^-100[1-9]\d*$/.test(chatId)) return { status: 'rejected', reason: 'unsupported_chat' };
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || messageId > 0x7FFFFFFF)
      throw new Error('Invalid Telegram message ID');

    // The archive is the sole authority on who posted the evidence. Moderation
    // never consults the message to identify its sender: that would make an
    // account unbanable the moment the message is deleted.
    const archived = deps.findAuthor(chatId, messageId);
    if (!archived) return { status: 'rejected', reason: 'unknown_message' };
    const userId = archived.userId;
    if (!/^[1-9]\d*$/.test(userId) || !Number.isSafeInteger(Number(userId)) || userId === deps.botUserId)
      return { status: 'rejected', reason: 'protected_user' };

    // Telegram cannot address a user by bare id, and the hash is scoped to the
    // bot's own session, so it has to be looked up live. It is only obtainable
    // while the account is still in the chat.
    const accessHash = await deps.api.resolveAccessHash(chatId, userId);
    if (!accessHash) {
      log.withFields({ chatId, userId }).warn('Target is not reachable through the bot session; nothing to address');
      return { status: 'rejected', reason: 'unresolved_target' };
    }

    const memberships = await deps.api.inspectMembers(chatId, { userId, accessHash });
    if (!memberships.canModerate) return { status: 'rejected', reason: 'missing_permissions' };
    if (memberships.status === 'protected') return { status: 'rejected', reason: 'protected_user' };

    const messageIds = deps.loadMessageIds(chatId, userId);
    if (messageIds.length === 0 || messageIds.length >= MESSAGE_LIMIT)
      return { status: 'rejected', reason: 'message_limit' };

    await deps.api.ban(chatId, { userId, status: memberships.status, inputUser: memberships.inputUser });

    const result: Extract<BanSpammerResult, { banned: true }> = {
      status: 'completed', userId, banned: true,
      deletedMessageIds: [], unavailableMessageIds: [], notDeletableMessageIds: [], failedMessageIds: [],
    };
    for (const id of messageIds) {
      try {
        // Deletion is independent of the ban: the archive already established
        // who posted this id, so only Telegram's retention window decides.
        const message = await deps.api.inspectMessage(chatId, id);
        if (!message) {
          result.unavailableMessageIds.push(id);
        } else if (Math.floor(Date.now() / 1000) - message.date >= BOT_DELETE_WINDOW_SEC) {
          result.notDeletableMessageIds.push(id);
        } else {
          await deps.api.deleteMessage(chatId, id);
          result.deletedMessageIds.push(id);
        }
      } catch (error) {
        result.failedMessageIds.push(id);
        log.withError(error).withFields({ chatId, userId, messageId: id }).error('Spam message deletion failed');
      }
    }
    if (result.notDeletableMessageIds.length > 0 || result.failedMessageIds.length > 0) result.status = 'partial';
    const removed = [...result.deletedMessageIds, ...result.unavailableMessageIds];
    if (removed.length > 0) deps.publishDeletions(chatId, removed);
    return result;
  };

  return { banSpammer };
};
