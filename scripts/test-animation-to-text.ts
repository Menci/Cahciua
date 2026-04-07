/**
 * End-to-end integration test for animationToText.
 * Downloads real media from Telegram, extracts frames, calls LLM.
 *
 * Usage: npx tsx scripts/test-animation-to-text.ts
 */
import { readFileSync } from 'node:fs';

import { useGlobalLogger, useLogger } from '@guiiai/logg';
import { parse as parseYaml } from 'yaml';

import { httpGetBuffer } from '../src/http';
import { createAnimationToTextResolver } from '../src/telegram/animation-to-text';
import { canExtractFrames, extractFrames } from '../src/telegram/frame-extractor';
import type { Attachment } from '../src/telegram/message/types';

const { Bot } = await import('grammy');

// Minimal logger setup
useGlobalLogger({ level: 'verbose', mode: 'pretty' });
const logger = useLogger('test');

// Load config
const config = parseYaml(readFileSync('config.yaml', 'utf-8'));
const modelName = config.chats?.default?.imageToText?.model ?? 'gemini-flash';
const model = config.models[modelName];
if (!model) throw new Error(`Model "${modelName}" not found in config`);
const botToken = config.telegram.botToken;

logger.withFields({ model: model.model, apiFormat: model.apiFormat ?? 'openai-chat' }).log('Using model');

// Lightweight file download (no polling)
const bot = new Bot(botToken);
const downloadFile = async (fileId: string): Promise<Buffer> => {
  const file = await bot.api.getFile(fileId);
  return httpGetBuffer(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
};

// Create resolver (no persistence, just test the LLM call)
const resolver = createAnimationToTextResolver({
  enabled: true,
  model: { ...model, apiFormat: model.apiFormat ?? 'openai-chat' },
  logger,
  lookupByHash: () => null,
  persist: record => logger.withFields({ hash: record.imageHash.slice(0, 12), tokens: record.altTextTokens }).log(`Would persist: ${record.altText}`),
});

const testCases: { label: string; fileId: string; att: Partial<Attachment>; caption: string }[] = [
  {
    label: 'GIF/Animation (MP4)',
    fileId: 'CgACAgQAAyEFAASBhZgdAAECgr1psHL4YApzz1WtkMlcU-q7J-1yrAACegoAAolY1FF_NowFAVNb2joE',
    att: { type: 'animation', mimeType: 'video/mp4', duration: 2 },
    caption: '',
  },
  {
    label: 'Video Sticker (WEBM)',
    fileId: 'CAACAgUAAyEFAASBhZgdAAECgUhpruQ7cXTeJzTVm011sdQAAVSdgZ8AAiEaAAJAIClU3DXLpqPdlDk6BA',
    att: { type: 'sticker', isVideoSticker: true, emoji: '😐', mimeType: 'video/webm' },
    caption: '',
  },
];

for (const tc of testCases) {
  console.log(`\n=== ${tc.label} ===`);

  // 1. Download
  console.log('  Downloading...');
  const buffer = await downloadFile(tc.fileId);
  console.log(`  Downloaded: ${buffer.length} bytes`);

  // 2. Extract frames
  const fullAtt = tc.att as Attachment;
  if (!canExtractFrames(fullAtt)) { console.log('  SKIP: not extractable'); continue; }

  console.log('  Extracting frames...');
  const { frames, cacheKey } = await extractFrames(buffer, fullAtt);
  console.log(`  Extracted ${frames.length} frames, hash: ${cacheKey.slice(0, 16)}...`);
  for (const [i, f] of frames.entries())
    console.log(`    Frame ${i}: ${f.length} bytes`);

  // 3. Call LLM
  console.log('  Calling LLM...');
  const record = await resolver.resolve({
    cacheKey,
    frames,
    caption: tc.caption,
    isSticker: tc.att.type === 'sticker',
    emoji: tc.att.emoji,
    duration: tc.att.duration,
  });
  console.log(`  Alt text (${record.altTextTokens} tokens): ${record.altText}`);
  console.log('  PASS');
}

console.log('\nALL TESTS PASSED');
