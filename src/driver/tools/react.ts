import { createTool } from './create-tool';
import type { CahciuaTool } from './types';

export const createReactTool = (
  setReaction: (messageId: number, emoji: string | undefined) => Promise<void>,
  messageExists: (messageId: number) => boolean,
): CahciuaTool => createTool({
  name: 'react',
  description: 'Add or remove your emoji reaction on a message in the current chat. Bot accounts can only set one reaction per message; calling react again replaces the previous one.',
  parameters: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: 'The ID of an existing message.' },
      emoji: { type: 'string', description: 'A single emoji (e.g. "👍", "❤️"). Required unless remove=true.' },
      remove: { type: 'boolean', description: 'Set to `true` to clear your reaction on this message instead of adding one. Defaults to `false`.' },
    },
    required: ['message_id'],
  },
  execute: async input => {
    const { message_id, emoji, remove } = input as { message_id: string; emoji?: string; remove?: boolean };
    const messageIdNum = Number(message_id);
    if (!Number.isFinite(messageIdNum)) throw new Error(`Invalid message_id: ${message_id}`);
    if (!messageExists(messageIdNum))
      return { content: JSON.stringify({ error: `No such message_id ${message_id} in this chat — refusing to call TDLib with an unknown id.` }), requiresFollowUp: true };
    const targetEmoji = remove ? undefined : emoji;
    if (!remove && !emoji) throw new Error('emoji is required when remove is not true');
    await setReaction(messageIdNum, targetEmoji);
    return { content: JSON.stringify({ ok: true }), requiresFollowUp: true };
  },
});
