import sharp from 'sharp';

import type { Attachment } from './message';

// Target ~100 tokens per image under Claude's formula: tokens = ceil(w*h / 750).
// 100 * 750 = 75,000 max pixels. For a square that's ~274px per side.
// We cap total pixels at 75,000 by limiting the long edge and relying on
// aspect-ratio-preserving resize (`fit: 'inside'`).
const THUMBNAIL_MAX_PIXELS = 75000;

export const generateThumbnail = async (buffer: Buffer): Promise<string> => {
  // First pass: read metadata to get dimensions
  const meta = await sharp(buffer).metadata();
  const w = meta.width ?? 512;
  const h = meta.height ?? 512;

  // Compute max long edge that keeps w*h ≤ THUMBNAIL_MAX_PIXELS.
  // For aspect ratio r = longEdge/shortEdge:
  //   shortEdge = longEdge / r, so longEdge * (longEdge / r) ≤ budget
  //   → longEdge ≤ sqrt(budget * r)
  const longEdge = Math.max(w, h);
  const shortEdge = Math.min(w, h);
  const ratio = longEdge / shortEdge;
  const maxLongEdge = Math.floor(Math.sqrt(THUMBNAIL_MAX_PIXELS * ratio));

  const webp = await sharp(buffer)
    .resize(maxLongEdge, maxLongEdge, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  return webp.toString('base64');
};

const THUMBNAIL_TYPES = new Set(['photo', 'sticker']);

export const canGenerateThumbnail = (attachment: Attachment): boolean =>
  THUMBNAIL_TYPES.has(attachment.type)
  && !attachment.isAnimatedSticker
  && !attachment.isVideoSticker;
