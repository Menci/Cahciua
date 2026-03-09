import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';

import type { Attachment } from '../db/schema';

export const generateThumbnail = async (buffer: Buffer): Promise<string> => {
  const webp = await sharp(buffer)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  return webp.toString('base64');
};

const THUMBNAIL_TYPES = new Set(['photo', 'sticker']);

export const canGenerateThumbnail = (attachment: Attachment): boolean =>
  THUMBNAIL_TYPES.has(attachment.type)
  && !attachment.isAnimatedSticker
  && !attachment.isVideoSticker;

export const hydrateAttachmentThumbnails = async (
  attachments: Attachment[] | undefined,
  downloadFile: (fileId: string) => Promise<Buffer>,
  logger: Logger,
): Promise<void> => {
  if (!attachments) return;

  for (const att of attachments) {
    if (!canGenerateThumbnail(att) || !att.fileId) continue;
    try {
      const buffer = await downloadFile(att.fileId);
      att.thumbnail = await generateThumbnail(buffer);
    } catch (err) {
      logger.withError(err).warn('Failed to generate thumbnail');
    }
  }
};
