import { createTool } from './create-tool';
import type { CahciuaTool } from './types';
import type { BanSpammerResult } from '../../telegram/moderation-types';

export const createBanSpammerTool = (
  banSpammer: (messageId: number) => Promise<BanSpammerResult>,
): CahciuaTool => createTool({
  name: 'ban_spammer',
  description: 'Permanently ban the verified author of a spam message in this chat and delete known messages that Telegram permits within the 48-hour bot window. Apply the moderation policy in the current chat system files. Eligible targets have fewer than 10 observed messages and a membership status authorized by the backend. After a confirmed ban, send the exact announcement returned by the tool; it describes the completed actions and any remaining cleanup.',
  parameters: {
    type: 'object',
    properties: {
      message_id: { type: 'string', pattern: '^[1-9][0-9]{0,9}$', description: 'An actual spam message ID in the current chat. Its verified author is the target.' },
      reason: { type: 'string', minLength: 1, maxLength: 1000, description: 'Explain how the account and message meet the group moderation criteria. This reason stays in the private audit record.' },
    },
    required: ['message_id', 'reason'],
    additionalProperties: false,
  },
  execute: async input => {
    const { message_id, reason } = input as { message_id: string; reason: string };
    if (reason.trim().length === 0) throw new Error('A moderation reason is required');
    const result = await banSpammer(Number(message_id));
    if (result.status === 'rejected')
      return { content: JSON.stringify(result), requiresFollowUp: true };

    const accountLink = `[spam 账号](tg://user?id=${result.userId})`;
    const announcement = result.status === 'completed'
      ? `已踢出并永久封禁 ${accountLink}，已清理记录中可删除的消息。`
      : `已踢出并永久封禁 ${accountLink}，部分消息需人工处理。`;
    return {
      content: JSON.stringify({
        ...result,
        announcement,
        next_action: 'Call send_message with exactly one argument: text, set to announcement exactly as provided. The fixed label and numeric UID link identify the account for public audit. Keep names, usernames, profile text, spam content, media, and reasoning in the private assessment. The supplied wording describes the confirmed ban and cleanup status.',
      }),
      requiresFollowUp: true,
    };
  },
});
