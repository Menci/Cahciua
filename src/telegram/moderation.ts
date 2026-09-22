import type { Logger } from '@guiiai/logg';

import type { BanSpammerResult, ModerationApi } from './moderation-types';

const MESSAGE_LIMIT = 10;
const BOT_DELETE_WINDOW_SEC = 48 * 60 * 60;

export const createModerationService = (deps: {
  api: ModerationApi;
  findSender: (chatId: string, messageId: number) => string | undefined;
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
    const userId = deps.findSender(chatId, messageId);
    if (!userId) return { status: 'rejected', reason: 'unknown_message' };
    if (!/^[1-9]\d*$/.test(userId) || !Number.isSafeInteger(Number(userId)) || userId === deps.botUserId)
      return { status: 'rejected', reason: 'protected_user' };

    const memberships = await deps.api.inspectMembers(chatId, userId);
    if (!memberships.canModerate) return { status: 'rejected', reason: 'missing_permissions' };
    if (memberships.targetStatus === 'protected') return { status: 'rejected', reason: 'protected_user' };

    const evidence = await deps.api.inspectMessage(chatId, messageId);
    if (evidence && evidence.senderId !== userId) return { status: 'rejected', reason: 'sender_mismatch' };
    // A repeated call can still clean up a banned user's messages after its evidence was deleted.
    if (!evidence && memberships.targetStatus !== 'banned') return { status: 'rejected', reason: 'unavailable_evidence' };

    const messageIds = deps.loadMessageIds(chatId, userId);
    if (messageIds.length === 0 || messageIds.length >= MESSAGE_LIMIT)
      return { status: 'rejected', reason: 'message_limit' };

    await deps.api.ban(chatId, userId);
    const result: Extract<BanSpammerResult, { banned: true }> = {
      status: 'completed', userId, banned: true,
      deletedMessageIds: [], unavailableMessageIds: [], notDeletableMessageIds: [], failedMessageIds: [],
    };
    for (const id of messageIds) {
      try {
        // Load the bot's own cache: TDLib silently skips unknown IDs during deletion.
        // https://github.com/tdlib/td/blob/a17f87c4cff7b90b278d12b91ba0614383aaee82/td/telegram/MessagesManager.cpp#L8272
        const message = await deps.api.inspectMessage(chatId, id);
        if (!message) {
          result.unavailableMessageIds.push(id);
        } else if (message.senderId !== userId) {
          throw new Error('Message sender changed during moderation');
        } else if (!message.canDelete || Math.floor(Date.now() / 1000) - message.date >= BOT_DELETE_WINDOW_SEC) {
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
