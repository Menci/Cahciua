import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

import sharp from 'sharp';

import type { Attachment } from './message';

const execFileAsync = promisify(execFile);

// Same budget as IMAGE_TO_TEXT_MAX_EDGE in image-to-text.ts
const FRAME_MAX_EDGE = 512;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const DEFAULT_MAX_FRAMES = 5;

// ffmpeg-static provides a bundled ffmpeg binary
const getFfmpegPath = async (): Promise<string> =>
  (await import('ffmpeg-static')).default!;

// ffprobe-static provides a bundled ffprobe binary
const getFfprobePath = async (): Promise<string> =>
  (await import('ffprobe-static')).default.path;

const hashBuffer = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');

export interface FrameExtractionResult {
  frames: Buffer[];
  cacheKey: string;
}

/** Whether this attachment can have frames extracted. */
export const canExtractFrames = (att: Attachment): boolean => {
  if (att.type === 'animation') return true;
  if (att.type === 'sticker' && (att.isVideoSticker || att.isAnimatedSticker))
    return true;
  return false;
};

/** Pick equidistant frame indices: ≤MAX keep all, >MAX pick MAX equidistant. */
const pickFrameIndices = (totalFrames: number, maxFrames = DEFAULT_MAX_FRAMES): number[] => {
  if (totalFrames <= 0) return [0];
  if (totalFrames <= maxFrames) return Array.from({ length: totalFrames }, (_, i) => i);
  // Equidistant: include first and last frame
  return Array.from({ length: maxFrames }, (_, i) =>
    Math.round(i * (totalFrames - 1) / (maxFrames - 1)));
};

const resizeFrame = (buffer: Buffer): Promise<Buffer> =>
  sharp(buffer)
    .resize(FRAME_MAX_EDGE, FRAME_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

// --- GIF extraction via sharp ---

const extractGifFrames = async (buffer: Buffer, maxFrames: number): Promise<Buffer[]> => {
  const meta = await sharp(buffer).metadata();
  const totalFrames = meta.pages ?? 1;
  const indices = pickFrameIndices(totalFrames, maxFrames);
  return await Promise.all(indices.map(async idx => {
    const raw = await sharp(buffer, { page: idx }).png().toBuffer();
    return await resizeFrame(raw);
  }));
};

// --- MP4/WEBM extraction via ffmpeg ---

const getVideoFrameCount = async (filePath: string): Promise<number> => {
  const ffprobe = await getFfprobePath();
  // Try nb_frames first (fast, from container metadata)
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_frames',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const count = parseInt(stdout.trim(), 10);
    if (!isNaN(count) && count > 0) return count;
  } catch { /* fall through */ }

  // Fallback: count by decoding (slower but reliable)
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const count = parseInt(stdout.trim(), 10);
  return isNaN(count) || count <= 0 ? 1 : count;
};

const extractVideoFrames = async (buffer: Buffer, maxFrames: number): Promise<Buffer[]> => {
  const ffmpeg = await getFfmpegPath();
  const dir = await mkdtemp(join(tmpdir(), 'cahciua-frames-'));
  const inputPath = join(dir, 'input');
  await writeFile(inputPath, buffer);

  try {
    const totalFrames = await getVideoFrameCount(inputPath);
    const indices = pickFrameIndices(totalFrames, maxFrames);
    const selectExpr = indices.map(n => `eq(n\\,${n})`).join('+');
    const outputPattern = join(dir, 'frame_%d.png');

    await execFileAsync(ffmpeg, [
      '-i', inputPath,
      '-vf', `select='${selectExpr}'`,
      '-vsync', 'vfr',
      outputPattern,
    ], { maxBuffer: 50 * 1024 * 1024 });

    // ffmpeg outputs 1-indexed: frame_1.png, frame_2.png, ...
    const frames: Buffer[] = [];
    for (let i = 1; i <= indices.length; i++) {
      try {
        const framePath = join(dir, `frame_${i}.png`);
        const raw = await sharp(framePath).png().toBuffer();
        frames.push(await resizeFrame(raw));
      } catch { /* skip missing frames */ }
    }
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

// --- TGS (Lottie) extraction via lottie-frame ---

const extractTgsFrames = async (buffer: Buffer, maxFrames: number): Promise<Buffer[]> => {
  const lottieJson = gunzipSync(buffer);
  const parsed = JSON.parse(lottieJson.toString('utf-8'));
  const inPoint = typeof parsed.ip === 'number' ? parsed.ip : 0;
  const outPoint = typeof parsed.op === 'number' ? parsed.op : 1;
  const totalFrames = Math.max(1, Math.round(outPoint - inPoint));
  const width = typeof parsed.w === 'number' ? parsed.w : 512;
  const height = typeof parsed.h === 'number' ? parsed.h : 512;

  const indices = pickFrameIndices(totalFrames, maxFrames);

  // lottie-frame is a CJS native addon
  const { exportFrame } = await import('lottie-frame');

  return await Promise.all(indices.map(async frameIdx => {
    // lottie-frame uses 0-based absolute frame indices (not Lottie's ip..op range)
    const png: Buffer = await exportFrame(lottieJson, {
      frame: frameIdx,
      width: Math.min(width, FRAME_MAX_EDGE),
      height: Math.min(height, FRAME_MAX_EDGE),
      quality: 80,
    });
    return await resizeFrame(png);
  }));
};

/** Extract equidistant frames from an animation buffer. */
export const extractFrames = async (
  buffer: Buffer,
  att: Attachment,
  maxFrames = DEFAULT_MAX_FRAMES,
): Promise<FrameExtractionResult> => {
  if (buffer.length > MAX_FILE_SIZE)
    throw new Error(`Animation file too large: ${buffer.length} bytes (max ${MAX_FILE_SIZE})`);

  const cacheKey = hashBuffer(buffer);

  // Detect TGS by gzip magic bytes — more reliable than attachment flags,
  // which are lost when reconstructing from CanonicalAttachment during backfill.
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;

  let frames: Buffer[];
  if (isGzip) {
    // TGS (gzipped Lottie JSON)
    frames = await extractTgsFrames(buffer, maxFrames);
  } else if (att.mimeType === 'image/gif') {
    // Native GIF (rare — Telegram usually converts to MP4)
    frames = await extractGifFrames(buffer, maxFrames);
  } else {
    // MP4 (animation/GIF) or WEBM (video sticker)
    frames = await extractVideoFrames(buffer, maxFrames);
  }

  if (frames.length === 0)
    throw new Error('No frames extracted from animation');

  return { frames, cacheKey };
};
