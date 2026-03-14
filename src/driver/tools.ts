import type { Tool } from 'xsai';

export const createSendMessageTool = (
  send: (text: string, replyTo?: string) => Promise<void>,
): Tool => ({
  type: 'function',
  function: {
    name: 'send_message',
    description: 'Send a message in the current conversation.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to send.' },
        reply_to: { type: 'string', description: 'A message id to reply to.' },
      },
      required: ['text'],
    },
  },
  execute: async input => {
    const { text, reply_to } = input as { text: string; reply_to?: string };
    await send(text, reply_to);
    return { ok: true };
  },
});
