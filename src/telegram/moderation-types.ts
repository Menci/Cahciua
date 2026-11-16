export type ModerationRejection =
  | 'disabled_chat'
  | 'unknown_message'
  | 'unsupported_chat'
  | 'protected_user'
  | 'message_limit'
  | 'missing_permissions'
  /** The bot has no access hash for the target, so Telegram cannot be asked to act on them. */
  | 'unresolved_target';

export type BanSpammerResult = {
  status: 'rejected';
  reason: ModerationRejection;
} | {
  status: 'completed' | 'partial';
  userId: string;
  banned: true;
  deletedMessageIds: number[];
  unavailableMessageIds: number[];
  notDeletableMessageIds: number[];
  failedMessageIds: number[];
};

/**
 * A ban target addressed through the bot's own MTProto identity. Telegram scopes
 * access hashes to the authorized account, so the bot's copy of the hash is the
 * only handle it can use.
 */
export interface ModerationTarget {
  userId: string;
  status: 'member' | 'left' | 'banned' | 'protected';
  inputUser: unknown;
}

export interface ModerationApi {
  /**
   * Look up the bot-session access hash for a user that is still in the chat.
   * Telegram scopes hashes per account and offers no way to address a bare user
   * id, so this is the only source for an account the bot has not seen yet.
   * Returns undefined once the user is gone, since nothing can be addressed then.
   */
  resolveAccessHash(chatId: string, userId: string): Promise<string | undefined>;
  /**
   * Report the bot's own rights in the chat and the target's current membership.
   * The target is identified purely by the archived user id plus the access hash
   * the caller already holds — moderation never needs the evidence message to
   * still exist.
   */
  inspectMembers(chatId: string, target: { userId: string; accessHash: string }): Promise<{
    canModerate: boolean;
    status: ModerationTarget['status'];
    inputUser: unknown;
  }>;
  /** Message timestamp, used only to decide whether Telegram still permits deletion. */
  inspectMessage(chatId: string, messageId: number): Promise<{ date: number } | undefined>;
  ban(chatId: string, target: ModerationTarget): Promise<void>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
}
