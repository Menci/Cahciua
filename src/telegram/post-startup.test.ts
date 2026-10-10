import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { expect, it, vi } from 'vitest';

import { createTelegramPostStartupTasks } from './post-startup';
import type { PipelineEvent } from '../projection';

vi.mock('../media/frame-extractor', () => ({ extractFrames: async () => ({ cacheKey: 'hash', frames: [], frameTimestamps: [] }) }));
initLogger(LogLevel.Error, Format.Pretty);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const event: Extract<PipelineEvent, { type: 'message' }> = {
  type: 'message', chatId: 'A', messageId: '1', receivedAtMs: 1000, timestampSec: 1, utcOffsetMin: 0,
  content: [{ type: 'custom_emoji', customEmojiId: '7', children: [{ type: 'text', text: 'x' }] }],
  attachments: [{ type: 'animation' }],
};

it.each(['download', 'description'] as const)('blocks late animation writes after shutdown during %s', async stage => {
  const delayed = deferred();
  const entered = deferred();
  const download = vi.fn(async () => { if (stage === 'download') { entered.resolve(); await delayed.promise; } return Buffer.from('fixture'); });
  const resolve = vi.fn(async () => { if (stage === 'description') { entered.resolve(); await delayed.promise; } return { imageHash: 'hash', altText: 'description', altTextTokens: 1 }; });
  const update = vi.fn();
  const tasks = createTelegramPostStartupTasks({
    manager: { downloadMessageMedia: download }, animationResolvers: new Map([['A', { resolve }]]),
    animationMaxFrames: new Map([['A', 1]]), customEmojiResolvers: new Map(), hasAltText: () => false,
    loadCompaction: () => null, loadEvents: () => [event], loadEventsWithId: () => [{ id: 1, event }],
    updateEventAttachments: update, hydrateAltText: vi.fn(), replayChat: vi.fn(), logger: useLogger('test'),
  });
  const running = tasks.run(); await entered.promise;
  tasks.stop(); delayed.resolve(); await running;
  expect(update).not.toHaveBeenCalled();
  await tasks.run(); expect(download).toHaveBeenCalledOnce();
});

it('blocks late emoji hydration and replay after shutdown', async () => {
  const delayed = deferred();
  const entered = deferred();
  const resolve = vi.fn(async () => { entered.resolve(); await delayed.promise; });
  const hydrate = vi.fn(); const replay = vi.fn();
  const tasks = createTelegramPostStartupTasks({
    manager: { downloadMessageMedia: vi.fn() }, animationResolvers: new Map(), animationMaxFrames: new Map(),
    customEmojiResolvers: new Map([['A', { resolve }]]), hasAltText: () => false,
    loadCompaction: () => null, loadEvents: () => [event], loadEventsWithId: () => [],
    updateEventAttachments: vi.fn(), hydrateAltText: hydrate, replayChat: replay, logger: useLogger('test'),
  });
  const running = tasks.run(); await entered.promise;
  tasks.stop(); delayed.resolve(); await running;
  expect(hydrate).not.toHaveBeenCalled(); expect(replay).not.toHaveBeenCalled();
});
