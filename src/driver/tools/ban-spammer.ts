import { createTool } from './create-tool';
import type { CahciuaTool } from './types';
import type { BanSpammerResult } from '../../telegram/moderation-types';

/**
 * Moderation output becomes public the moment the model writes it, and the
 * material behind it is attacker-controlled: a display name or message body can
 * itself be the advertisement. Repeat this constraint on every error path,
 * because a failed attempt is when the model is tempted to describe what it saw.
 */
const CONFIDENTIALITY_NOTICE = 'Do not repeat the spam message text, the sender display name or username, profile text, or any detail about the content, links, or moderation reasoning. When reporting an error for human administrators, state only the operational failure (and the provided numeric UID link if available) so they can inspect safely.';

/**
 * A target who already left (`unresolved`) or messages that were already gone
 * (`unavailableMessageIds`) are expected outcomes, not operational failures.
 * Only conditions that leave actionable work blocked require human attention.
 */
const hasOperationalProblem = (
  result: Exclude<BanSpammerResult, { status: 'rejected' }>,
): boolean =>
  (result.ban.status !== 'banned' && result.ban.status !== 'unresolved')
  || result.deletion.notDeletableMessageIds.length > 0
  || result.deletion.failedMessageIds.length > 0;

export const createBanSpammerTool = (
  banSpammer: (messageId: number) => Promise<BanSpammerResult>,
): CahciuaTool => createTool({
  name: 'ban_spammer',
  description: 'Permanently ban the verified author of a spam message in this chat and delete known messages that Telegram permits within the 48-hour bot window. Apply the moderation policy in the current chat system files. Eligible targets have fewer than 10 observed messages. Summoned inline bots and their summoners remain eligible, including accounts outside the group; owners and administrators are protected. Stay silent when moderation succeeds or when the target or its messages were already gone; send a brief anonymous error notice only if an unexpected operational failure requires human administrator attention.',
  parameters: {
    type: 'object',
    properties: {
      message_id: { type: 'string', pattern: '^[1-9][0-9]{0,9}$', description: 'An actual spam message ID in the current chat. Its verified author is the target.' },
      reason: { type: 'string', minLength: 1, maxLength: 1000, description: 'Explain how the account and message meet the group moderation criteria. This reason stays in the private audit record.' },
    },
    required: ['message_id', 'reason'],
    additionalProperties: false,
  },
  failureMessage: `The moderation request failed with an unexpected error before completion. Report briefly that spam moderation failed so human administrators can inspect. ${CONFIDENTIALITY_NOTICE}`,
  execute: async input => {
    const { message_id, reason } = input as { message_id: string; reason: string };
    if (reason.trim().length === 0) throw new Error('A moderation reason is required');
    const result = await banSpammer(Number(message_id));
    if (result.status === 'rejected') {
      return {
        content: JSON.stringify({
          ...result,
          confidentiality: CONFIDENTIALITY_NOTICE,
          next_action: 'Moderation was rejected and nothing was changed. If a genuine spam incident could not be handled automatically (for example, message_limit on a flood), send a brief error notice for human administrators without naming or quoting the account; if no human intervention is needed, stay silent and finish with end_turn.',
        }),
        requiresFollowUp: true,
      };
    }

    if (!hasOperationalProblem(result)) {
      return {
        content: JSON.stringify({
          ...result,
          next_action: 'Moderation settled with no error (including any target already absent from the group or messages already deleted). Do not send any message about this account or its removal; finish with end_turn once no other action remains in this turn.',
        }),
        requiresFollowUp: true,
      };
    }

    const accountLink = `[spam 账号](tg://user?id=${result.userId})`;
    return {
      content: JSON.stringify({
        ...result,
        account_link: accountLink,
        confidentiality: CONFIDENTIALITY_NOTICE,
        next_action: 'Moderation hit an operational problem requiring human administrator attention (missing bot permissions, protected target, failed message deletions, or messages older than the 48-hour bot deletion window). Send a brief factual error notice via send_message using account_link for audit, and strictly follow confidentiality.',
      }),
      requiresFollowUp: true,
    };
  },
});
