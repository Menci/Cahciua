export type ModerationRejection =
  | 'disabled_chat'
  | 'unknown_message'
  | 'unsupported_chat'
  | 'protected_user'
  | 'message_limit'
  | 'missing_permissions'
  | 'sender_mismatch';

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
 * A ban target addressed through the bot's own MTProto identity. Telegram
 * scopes access hashes to the authorized account, so the handle must be
 * resolved from a bot-side response before any moderation call.
 */
export interface ModerationTarget {
  userId: string;
  status: 'member' | 'left' | 'banned' | 'protected';
  inputUser: unknown;
}

export interface ModerationApi {
  /**
   * Resolve the target and report both the bot's rights and the target's
   * current status. `username` is the ingress-observed fallback handle for an
   * account whose evidence message is already gone.
   */
  inspectMembers(chatId: string, evidence: { messageId: number; userId: string; username?: string }): Promise<{
    canModerate: boolean;
    target?: ModerationTarget;
  }>;
  inspectMessage(chatId: string, messageId: number): Promise<{
    senderId: string | undefined;
    date: number;
    canDelete: boolean;
  } | undefined>;
  ban(chatId: string, target: ModerationTarget): Promise<void>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
}
