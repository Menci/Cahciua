export type ModerationRejection =
  | 'disabled_chat'
  | 'unknown_message'
  | 'unsupported_chat'
  | 'protected_user'
  | 'message_limit'
  | 'missing_permissions'
  | 'unavailable_evidence'
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

export interface ModerationApi {
  inspectMembers(chatId: string, userId: string): Promise<{
    canModerate: boolean;
    targetStatus: 'member' | 'banned' | 'protected';
  }>;
  inspectMessage(chatId: string, messageId: number): Promise<{
    senderId: string | undefined;
    date: number;
    canDelete: boolean;
  } | undefined>;
  ban(chatId: string, userId: string): Promise<void>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
}
