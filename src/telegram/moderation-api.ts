import { Api, type TelegramClient } from 'teleproto';

import type { ModerationApi, ModerationTarget } from './moderation-types';
import { createChatPeerResolver } from './peer';

const participantStatus = (participant: Api.TypeChannelParticipant): ModerationTarget['status'] => {
  if (participant instanceof Api.ChannelParticipantCreator || participant instanceof Api.ChannelParticipantAdmin) return 'protected';
  if (participant instanceof Api.ChannelParticipantBanned) return 'banned';
  if (participant instanceof Api.ChannelParticipantLeft) return 'left';
  return 'member';
};

const NOT_A_PARTICIPANT = /USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|CHANNEL_INVALID/;

/**
 * Spam moderation runs as the bot. Telegram scopes access hashes to the
 * authorized account, so every `InputUser` here comes from a response the bot
 * itself received: the evidence message for its author, and username resolution
 * for an account that already left or never joined. Hashes captured by userbot
 * ingress belong to that account and are rejected by the server.
 */
export const createModerationApi = (client: TelegramClient): ModerationApi => {
  const resolveChatPeer = createChatPeerResolver(client);
  const channelPeer = async (chatId: string): Promise<Api.InputPeerChannel> => {
    const peer = await resolveChatPeer(chatId);
    if (!(peer instanceof Api.InputPeerChannel)) throw new Error('Spam moderation requires a supergroup');
    return peer;
  };

  const fetchMessage = async (chatId: string, messageId: number): Promise<Api.Message | undefined> => {
    const messages = await client.getMessages(await channelPeer(chatId), { ids: [messageId] });
    const message = messages[0];
    return message instanceof Api.Message ? message : undefined;
  };

  /**
   * The evidence message is authoritative: Telegram returns its author along
   * with a bot-side access hash. When the message is already gone, the username
   * captured at ingress is the remaining handle. Both paths verify the account
   * id, so a stale archive row can never redirect a ban.
   */
  const resolveUser = async (chatId: string, evidence: { messageId: number; userId: string; username?: string }): Promise<Api.User | undefined> => {
    const message = await fetchMessage(chatId, evidence.messageId);
    const sender = message?.fromId ?? message?.senderId;
    if (sender instanceof Api.PeerUser && String(sender.userId) === evidence.userId) {
      const user = message?._entities?.get(evidence.userId);
      if (user instanceof Api.User) return user;
    }
    if (!evidence.username) return undefined;
    const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username: evidence.username }));
    const user = resolved.users.find((candidate): candidate is Api.User => candidate instanceof Api.User);
    return user && String(user.id) === evidence.userId ? user : undefined;
  };

  return {
    inspectMembers: async (chatId, evidence) => {
      const channel = await channelPeer(chatId);
      const self = await client.invoke(new Api.channels.GetParticipant({
        channel,
        participant: new Api.InputPeerSelf(),
      }));
      const selfStatus = self.participant;
      const canModerate = selfStatus instanceof Api.ChannelParticipantCreator
        || (selfStatus instanceof Api.ChannelParticipantAdmin
          && selfStatus.adminRights.deleteMessages === true
          && selfStatus.adminRights.banUsers === true);

      const user = await resolveUser(chatId, evidence);
      if (!user?.accessHash) return { canModerate };

      const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash });
      let status: ModerationTarget['status'] = 'left';
      try {
        const result = await client.invoke(new Api.channels.GetParticipant({ channel, participant: inputUser }));
        status = participantStatus(result.participant);
      } catch (error) {
        if (!(error instanceof Error) || !NOT_A_PARTICIPANT.test(error.message)) throw error;
      }
      return {
        canModerate,
        target: { userId: String(user.id), status, inputUser },
      };
    },

    inspectMessage: async (chatId, messageId) => {
      const message = await fetchMessage(chatId, messageId);
      if (!message) return undefined;
      const sender = message.fromId ?? message.senderId;
      return {
        senderId: sender instanceof Api.PeerUser ? String(sender.userId) : undefined,
        date: message.date,
        // Bots can delete any message an admin's rights allow; the archive
        // already bounds deletion by Telegram's 48-hour window.
        canDelete: true,
      };
    },

    ban: async (chatId, target) => {
      await client.invoke(new Api.channels.EditBanned({
        channel: await channelPeer(chatId),
        participant: target.inputUser as Api.TypeInputPeer,
        bannedRights: new Api.ChatBannedRights({ untilDate: 0, viewMessages: true }),
      }));
    },

    deleteMessage: async (chatId, messageId) => {
      await client.invoke(new Api.channels.DeleteMessages({
        channel: await channelPeer(chatId),
        id: [messageId],
      }));
    },
  };
};
