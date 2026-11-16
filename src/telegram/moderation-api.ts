import bigInt from 'big-integer';
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
 * Spam moderation runs as the bot and addresses targets purely by id plus the
 * bot's stored access hash. It deliberately never reads the evidence message to
 * learn who the target is: the archive already answers that, and a deleted
 * message would otherwise make an account unbanable. The message is only read
 * for its timestamp, to decide whether deletion is still within Telegram's
 * window.
 */
export const createModerationApi = (client: TelegramClient): ModerationApi => {
  const resolveChatPeer = createChatPeerResolver(client);
  const channelPeer = async (chatId: string): Promise<Api.InputPeerChannel> => {
    const peer = await resolveChatPeer(chatId);
    if (!(peer instanceof Api.InputPeerChannel)) throw new Error('Spam moderation requires a supergroup');
    return peer;
  };

  /**
   * Hashes are only obtainable while the account is still a participant, so this
   * walks the member list rather than reading any message. Telegram paginates by
   * offset without an incremental API, and the search filter matches the query
   * against names that spammers control, so every page is scanned by id.
   */
  const resolveAccessHash = async (chatId: string, userId: string): Promise<string | undefined> => {
    const channel = await channelPeer(chatId);
    const pageSize = 200;
    for (let offset = 0; ; offset += pageSize) {
      const page = await client.invoke(new Api.channels.GetParticipants({
        channel,
        filter: new Api.ChannelParticipantsRecent(),
        offset,
        limit: pageSize,
        hash: bigInt(0),
      }));
      if (page instanceof Api.channels.ChannelParticipantsNotModified) return undefined;
      for (const candidate of page.users) {
        if (candidate instanceof Api.User && String(candidate.id) === userId && candidate.accessHash != null)
          return String(candidate.accessHash);
      }
      if (page.users.length < pageSize || offset + page.users.length >= page.count) return undefined;
    }
  };

  return {
    resolveAccessHash,

    inspectMembers: async (chatId, target) => {
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

      const inputUser = new Api.InputUser({
        userId: bigInt(target.userId),
        accessHash: bigInt(target.accessHash),
      });
      try {
        const result = await client.invoke(new Api.channels.GetParticipant({ channel, participant: inputUser }));
        return { canModerate, status: participantStatus(result.participant), inputUser };
      } catch (error) {
        // A target who left or was never a member is still bannable, so an
        // unknown-participant answer means "not currently here", not "invalid".
        if (!(error instanceof Error) || !NOT_A_PARTICIPANT.test(error.message)) throw error;
        return { canModerate, status: 'left', inputUser };
      }
    },

    inspectMessage: async (chatId, messageId) => {
      const messages = await client.getMessages(await channelPeer(chatId), { ids: [messageId] });
      const message = messages[0];
      return message instanceof Api.Message ? { date: message.date } : undefined;
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
