import type { Attachment } from '../../telegram/message/types';

export const createAttachmentDownloader = (deps: {
  chatId: string;
  loadMessageAttachments: (chatId: string, messageId: number) => Attachment[] | undefined;
  downloadMessageMedia: (chatId: string, messageId: number) => Promise<Buffer | undefined>;
}): (fileId: string) => Promise<Buffer> =>
  async (fileId: string): Promise<Buffer> => {
    const colonIdx = fileId.lastIndexOf(':');
    if (colonIdx < 0) throw new Error('Invalid file_id format. Expected "messageId:index".');

    const messageId = parseInt(fileId.slice(0, colonIdx), 10);
    const attachmentIndex = parseInt(fileId.slice(colonIdx + 1), 10);
    if (isNaN(messageId) || isNaN(attachmentIndex) || attachmentIndex < 0)
      throw new Error('Invalid file_id: messageId or index is not a valid number.');

    const attachments = deps.loadMessageAttachments(deps.chatId, messageId);
    if (!attachments || attachments.length === 0)
      throw new Error(`No attachments found for message ${messageId}.`);
    if (attachments.length !== 1 || attachmentIndex !== 0)
      throw new Error('Telegram messages must expose exactly one downloadable attachment at index 0');

    const buffer = await deps.downloadMessageMedia(deps.chatId, messageId);
    if (!buffer)
      throw new Error('Failed to download file from Telegram.');

    return buffer;
  };
