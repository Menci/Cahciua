import type { Client } from 'tdl';
import type * as Td from 'tdlib-types';

import { serverToTdLibMessageId } from './message/id-conversion';
import type { ModerationApi } from './moderation-types';

const hasModerationRights = (status: Td.ChatMemberStatus): boolean =>
  status._ === 'chatMemberStatusCreator'
  || (status._ === 'chatMemberStatusAdministrator'
    && status.rights.can_restrict_members && status.rights.can_delete_messages);

export const createModerationApi = (client: Pick<Client, 'invoke'>, botUserId: string): ModerationApi => ({
  inspectMembers: async (chatId, userId) => {
    const chat = await client.invoke({ _: 'getChat', chat_id: Number(chatId) });
    if (chat.type._ !== 'chatTypeSupergroup' || chat.type.is_channel)
      throw new Error('Spam moderation requires a supergroup');
    const [self, target] = await Promise.all([botUserId, userId].map(id => client.invoke({
      _: 'getChatMember',
      chat_id: Number(chatId),
      member_id: { _: 'messageSenderUser', user_id: Number(id) },
    })));
    const status = target!.status;
    return {
      canModerate: hasModerationRights(self!.status),
      targetStatus: status._ === 'chatMemberStatusBanned' ? 'banned'
        : status._ === 'chatMemberStatusMember' || (status._ === 'chatMemberStatusRestricted' && status.is_member)
          ? 'member' : 'protected',
    };
  },

  inspectMessage: async (chatId, messageId) => {
    const message = await client.invoke({
      _: 'getMessages',
      chat_id: Number(chatId),
      message_ids: [serverToTdLibMessageId(messageId)],
    });
    const target = message.messages[0];
    if (!target) return undefined;
    const properties = await client.invoke({
      _: 'getMessageProperties',
      chat_id: Number(chatId),
      message_id: target.id,
    });
    return {
      senderId: target.sender_id._ === 'messageSenderUser' ? String(target.sender_id.user_id) : undefined,
      date: target.date,
      canDelete: properties.can_be_deleted_for_all_users,
    };
  },

  ban: async (chatId, userId) => {
    await client.invoke({
      _: 'banChatMember',
      chat_id: Number(chatId),
      member_id: { _: 'messageSenderUser', user_id: Number(userId) },
      banned_until_date: 0,
      revoke_messages: true,
    });
  },

  deleteMessage: async (chatId, messageId) => {
    await client.invoke({
      _: 'deleteMessages',
      chat_id: Number(chatId),
      message_ids: [serverToTdLibMessageId(messageId)],
      revoke: true,
    });
  },
});
