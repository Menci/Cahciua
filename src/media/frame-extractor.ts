import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

import sharp from 'sharp';

const execFileAsync = promisify(execFile);

// Same budget as IMAGE_TO_TEXT_MAX_EDGE in image-to-text.ts
const FRAME_MAX_EDGE = 512;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const DEFAULT_MAX_FRAMES = 5;

const getFfmpegPath = async (): Promise<string> =>
  (await import('ffmpeg-static')).default!;

const getFfprobePath = async (): Promise<string> =>
  (await import('ffprobe-static')).default.path;

const hashBuffer = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');

export const deduplicateFrames = (frames: Buffer[]): Buffer[] => {
  const seen = new Set<string>();
  const unique: Buffer[] = [];
  for (const frame of frames) {
    const hash = hashBuffer(frame);
    if (!seen.has(hash)) {
      seen.add(hash);
      unique.push(frame);
    }
  }
  return unique;
};

export interface FrameExtractionResult {
  frames: Buffer[];
  cacheKey: string;
  frameTimestamps?: number[];
}

export interface FrameCandidate {
  type: string;
  isAnimatedSticker?: boolean;
  isVideoSticker?: boolean;
  mimeType?: string;
}

export interface FrameSource extends FrameCandidate {
  type: 'animation' | 'sticker';
}

export const canExtractFrames = <T extends FrameCandidate>(att: T): att is T & FrameSource => {
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
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();

// --- GIF extraction via sharp ---

const extractGifFrames = async (buffer: Buffer, maxFrames: number): Promise<{ frames: Buffer[]; frameTimestamps?: number[] }> => {
  const meta = await sharp(buffer).metadata();
  const totalFrames = meta.pages ?? 1;
  const indices = pickFrameIndices(totalFrames, maxFrames);
  const frames = await Promise.all(indices.map(async idx => {
    const raw = await sharp(buffer, { page: idx }).png().toBuffer();
    return await resizeFrame(raw);
  }));
  // GIF: no reliable FPS source → omit timestamps
  return { frames };
};

// --- MP4/WEBM extraction via ffmpeg ---

// Container metadata (`nb_frames`, `r_frame_rate`) describes stored packets, not
// what the decoder emits: an edit list from a stream-copied cut hides leading
// packets, and VFR streams report a timebase-like rate. `select` numbers the
// decoded frames, so we index and timestamp exactly those, from one decode pass.
const probeDecodedFrameTimes = async (filePath: string): Promise<number[]> => {
  const ffprobe = await getFfprobePath();
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'frame=best_effort_timestamp_time',
    '-of', 'csv=p=0',
    filePath,
  ], { maxBuffer: 10 * 1024 * 1024 });
  const times = stdout.split('\n').filter(line => line.trim() !== '').map(line => {
    const time = Number(line.trim().replace(/,$/, ''));
    if (!Number.isFinite(time)) throw new Error(`ffprobe returned a non-numeric frame time: ${line}`);
    return time;
  });
  if (times.length === 0) throw new Error('ffprobe decoded no video frames');
  return times;
};

const extractVideoFrames = async (buffer: Buffer, maxFrames: number): Promise<{ frames: Buffer[]; frameTimestamps: number[] }> => {
  const ffmpeg = await getFfmpegPath();
  const dir = await mkdtemp(join(tmpdir(), 'cahciua-frames-'));
  const inputPath = join(dir, 'input');
  await writeFile(inputPath, buffer);

  try {
    const frameTimes = await probeDecodedFrameTimes(inputPath);
    const indices = pickFrameIndices(frameTimes.length, maxFrames);
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
      const raw = await sharp(join(dir, `frame_${i}.png`)).png().toBuffer();
      frames.push(await resizeFrame(raw));
    }

    const startTime = frameTimes[0]!;
    const frameTimestamps = indices.map(i => frameTimes[i]! - startTime);
    return { frames, frameTimestamps };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

// --- TGS (Lottie) extraction via lottie-frame ---

const extractTgsFrames = async (buffer: Buffer, maxFrames: number): Promise<{ frames: Buffer[]; frameTimestamps?: number[] }> => {
  const lottieJson = gunzipSync(buffer);
  const parsed = JSON.parse(lottieJson.toString('utf-8')) as Record<string, unknown>;
  const numberField = (name: string): number => {
    const value = parsed[name];
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(`TGS field ${name} must be a finite number`);
    return value;
  };
  const inPoint = numberField('ip');
  const outPoint = numberField('op');
  // rlottie exposes valid frame indices as 0..totalFrame()-1. Lottie `op` may be
  // fractional; rounding can select `totalFrame()` itself and crash native export.
  const totalFrames = Math.max(1, Math.floor(outPoint - inPoint));
  const width = numberField('w');
  const height = numberField('h');
  const fps = numberField('fr');
  if (outPoint <= inPoint || width <= 0 || height <= 0 || fps <= 0)
    throw new Error('TGS dimensions, frame range, and frame rate must be positive');

  const indices = pickFrameIndices(totalFrames, maxFrames);

  // lottie-frame is a CJS native addon
  const { exportFrame } = await import('lottie-frame');

  const frames = await Promise.all(indices.map(async frameIdx => {
    // lottie-frame uses 0-based absolute frame indices (not Lottie's ip..op range)
    const png: Buffer = await exportFrame(lottieJson, {
      frame: frameIdx,
      width: Math.min(width, FRAME_MAX_EDGE),
      height: Math.min(height, FRAME_MAX_EDGE),
      quality: 80,
    });
    return await resizeFrame(png);
  }));

  const frameTimestamps = indices.map(i => i / fps);
  return { frames, frameTimestamps };
};

export const extractFrames = async (
  buffer: Buffer,
  att: FrameCandidate,
  maxFrames = DEFAULT_MAX_FRAMES,
): Promise<FrameExtractionResult> => {
  if (buffer.length > MAX_FILE_SIZE)
    throw new Error(`Animation file too large: ${buffer.length} bytes (max ${MAX_FILE_SIZE})`);

  const cacheKey = hashBuffer(buffer);

  // Detect TGS by gzip magic bytes — more reliable than attachment flags,
  // which are lost when reconstructing from CanonicalAttachment during backfill.
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;

  let result: { frames: Buffer[]; frameTimestamps?: number[] };
  if (isGzip) {
    // TGS (gzipped Lottie JSON)
    result = await extractTgsFrames(buffer, maxFrames);
  } else if (att.mimeType === 'image/gif') {
    // Native GIF (rare — Telegram usually converts to MP4)
    result = await extractGifFrames(buffer, maxFrames);
  } else {
    // MP4 (animation/GIF) or WEBM (video sticker)
    result = await extractVideoFrames(buffer, maxFrames);
  }

  if (result.frames.length === 0)
    throw new Error('No frames extracted from animation');

  return { frames: result.frames, cacheKey, frameTimestamps: result.frameTimestamps };
};
