import type { Logger } from '@guiiai/logg';

import type { BanOutcome, BanSpammerResult, DeletionOutcome, ModerationApi } from './moderation-types';

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

  /**
   * Ban and deletion are independent operations and are attempted independently:
   * an account that already left cannot be addressed, yet its messages are still
   * removable, and a failed deletion never invalidates a completed ban.
   */
  const removeKnownMessages = async (chatId: string, userId: string, messageIds: number[]): Promise<DeletionOutcome> => {
    const outcome: DeletionOutcome = {
      deletedMessageIds: [], unavailableMessageIds: [], notDeletableMessageIds: [], failedMessageIds: [],
    };
    for (const id of messageIds) {
      try {
        // Only Telegram's retention window decides; the archive already
        // established who posted this id.
        const message = await deps.api.inspectMessage(chatId, id);
        if (!message) {
          outcome.unavailableMessageIds.push(id);
        } else if (Math.floor(Date.now() / 1000) - message.date >= BOT_DELETE_WINDOW_SEC) {
          outcome.notDeletableMessageIds.push(id);
        } else {
          await deps.api.deleteMessage(chatId, id);
          outcome.deletedMessageIds.push(id);
        }
      } catch (error) {
        outcome.failedMessageIds.push(id);
        log.withError(error).withFields({ chatId, userId, messageId: id }).error('Spam message deletion failed');
      }
    }
    const removed = [...outcome.deletedMessageIds, ...outcome.unavailableMessageIds];
    if (removed.length > 0) deps.publishDeletions(chatId, removed);
    return outcome;
  };

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

    const messageIds = deps.loadMessageIds(chatId, userId);
    if (messageIds.length === 0 || messageIds.length >= MESSAGE_LIMIT)
      return { status: 'rejected', reason: 'message_limit' };

    // Telegram cannot address a user by bare id, and the hash is scoped to the
    // bot's own session, so it has to be looked up live. It is only obtainable
    // while the account is still in the chat. A target who already left cannot
    // be addressed at all, so the ban is reported as unresolved and its messages
    // are still removed below.
    const accessHash = await deps.api.resolveAccessHash(chatId, userId);
    let ban: BanOutcome;
    if (!accessHash) {
      log.withFields({ chatId, userId }).log('Target is not addressable; deleting its messages only');
      ban = { status: 'unresolved' };
    } else {
      const memberships = await deps.api.inspectMembers(chatId, { userId, accessHash });
      if (!memberships.canModerate) ban = { status: 'missing_permissions' };
      else if (memberships.status === 'protected') ban = { status: 'protected' };
      else {
        await deps.api.ban(chatId, { userId, status: memberships.status, inputUser: memberships.inputUser });
        ban = { status: 'banned' };
      }
    }

    const deletion = await removeKnownMessages(chatId, userId, messageIds);
    const incomplete = ban.status !== 'banned'
      || deletion.notDeletableMessageIds.length > 0
      || deletion.failedMessageIds.length > 0;
    return { status: incomplete ? 'partial' : 'completed', userId, ban, deletion };
  };

  return { banSpammer };
};
