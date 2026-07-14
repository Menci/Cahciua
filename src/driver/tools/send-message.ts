import { createTool } from './create-tool';
import type { CahciuaTool } from './types';

export interface SendMessageAttachment {
  type: 'document' | 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'video_note';
  path: string;
  file_name?: string;
}

export const createSendMessageTool = (
  send: (text: string, replyTo?: string, attachments?: SendMessageAttachment[]) => Promise<{ messageId: string }>,
  messageExists: (messageId: number) => boolean,
): CahciuaTool => {
  const properties: Record<string, unknown> = {
    text: { type: 'string', description: 'The message to send. When sending attachments, this becomes the caption.' },
    reply_to: { type: 'string', description: 'A message id to reply to.' },
    await_response: {
      type: 'boolean',
      description: 'Set to true when another model step is required after this message. Defaults to false.',
    },
    attachments: {
      type: 'array',
      description: 'Media attachments to send. Multiple attachments are sent as a media group (album). Telegram media groups support up to 10 items; photos and videos can be mixed, but audio and documents must be grouped separately.',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['document', 'photo', 'video', 'audio', 'voice', 'animation', 'video_note'],
            description: 'The type of media to send.',
          },
          path: { type: 'string', description: 'File path in the workspace.' },
          file_name: { type: 'string', description: 'Override filename (for document type only).' },
        },
        required: ['type', 'path'],
      },
    },
  };

  return createTool({
    name: 'send_message',
    description: 'Send a message in the current conversation, optionally with media attachments.',
    parameters: {
      type: 'object',
      properties,
      required: ['text'],
    },
    execute: async input => {
      const { text, reply_to, await_response, attachments } = input as {
        text: string;
        reply_to?: string;
        await_response?: boolean;
        attachments?: SendMessageAttachment[];
      };
      if (reply_to != null && reply_to !== '') {
        const replyToNum = Number(reply_to);
        if (!Number.isFinite(replyToNum) || !messageExists(replyToNum))
          return { content: JSON.stringify({ error: `No such reply_to message_id ${reply_to} in this chat — refusing to call TDLib with an unknown id. Send the message without reply_to, or use a valid id.` }), requiresFollowUp: true };
      }
      const result = await send(text, reply_to, attachments);
      return {
        content: JSON.stringify({ ok: true, message_id: result.messageId }),
        requiresFollowUp: await_response ?? false,
      };
    },
  });
};
