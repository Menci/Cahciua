import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import ffmpegPath from 'ffmpeg-static';
import { describe, expect, it } from 'vitest';

import { canExtractFrames, extractFrames } from './frame-extractor';
import type { Attachment } from './message/types';

const exec = promisify(execFile);

describe('canExtractFrames', () => {
  const cases: [string, Partial<Attachment>, boolean][] = [
    ['animation', { type: 'animation' }, true],
    ['video sticker', { type: 'sticker', isVideoSticker: true }, true],
    ['animated sticker (TGS)', { type: 'sticker', isAnimatedSticker: true }, true],
    ['animated custom emoji', { type: 'sticker', isAnimatedSticker: true, customEmojiId: '123' }, false],
    ['static sticker', { type: 'sticker' }, false],
    ['photo', { type: 'photo' }, false],
    ['video', { type: 'video' }, false],
    ['document', { type: 'document' }, false],
  ];

  for (const [label, att, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      expect(canExtractFrames(att as Attachment)).toBe(expected);
    });
  }
});

describe('extractFrames', () => {
  it('TGS: ≤5 frames → keep all', async () => {
    const lottie = { v: '5.5.2', fr: 30, ip: 0, op: 3, w: 64, h: 64, layers: [] };
    const tgs = gzipSync(Buffer.from(JSON.stringify(lottie)));
    const result = await extractFrames(tgs, { type: 'sticker', isAnimatedSticker: true } as Attachment);
    expect(result.frames).toHaveLength(3);
    expect(result.cacheKey).toHaveLength(64); // sha256 hex
    for (const f of result.frames) expect(f.length).toBeGreaterThan(0);
  });

  it('TGS: >5 frames → equidistant 5', async () => {
    const lottie = { v: '5.5.2', fr: 30, ip: 0, op: 60, w: 64, h: 64, layers: [] };
    const tgs = gzipSync(Buffer.from(JSON.stringify(lottie)));
    const result = await extractFrames(tgs, { type: 'sticker', isAnimatedSticker: true } as Attachment);
    expect(result.frames).toHaveLength(5);
  });

  it('MP4: extracts 5 equidistant frames', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vitest-frames-'));
    try {
      const videoPath = join(dir, 'test.mp4');
      await exec(ffmpegPath!, [
        '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=30',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
      ]);
      const buf = await readFile(videoPath);
      const result = await extractFrames(buf, { type: 'animation', mimeType: 'video/mp4' } as Attachment);
      expect(result.frames.length).toBe(5);
      expect(result.cacheKey).toHaveLength(64);
      for (const f of result.frames) expect(f.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  }, 30000);

  it('rejects files exceeding 20MB', async () => {
    const huge = Buffer.alloc(21 * 1024 * 1024);
    await expect(extractFrames(huge, { type: 'animation' } as Attachment))
      .rejects.toThrow('too large');
  });
});
