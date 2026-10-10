import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { expect, it, vi } from 'vitest';

vi.mock('../../db', async importOriginal => ({
  ...await importOriginal<typeof import('../../db')>(),
  persistImageAltText: vi.fn(), updateEventAttachments: vi.fn(),
}));
vi.mock('../../media/runtime', () => ({ createMediaRuntime: vi.fn(() => ({})) }));
vi.mock('../../telegram', async importOriginal => ({
  ...await importOriginal<typeof import('../../telegram')>(), createTelegramPostStartupTasks: vi.fn(() => ({})),
}));

import { registerDriver } from './driver';
import { registerMedia } from './media';
import { persistImageAltText, updateEventAttachments } from '../../db';
import { createHistoryAccess } from '../../history/access';
import { createHistoryRuntime } from '../../history/runtime';
import { createMediaRuntime } from '../../media/runtime';
import { createTelegramPostStartupTasks } from '../../telegram';
import type { Token } from '../tokens';
import { TOKENS } from '../tokens';

initLogger(LogLevel.Error, Format.Pretty);

it.each([true, false])('publishes committed media facts without starting or waiting for History (enabled=%s)', async enabled => {
  const access = createHistoryAccess({ enabled });
  const options = vi.fn(() => { throw new Error('Producer must not resolve worker options'); });
  const runtime = createHistoryRuntime({ access, options, logger: useLogger('notification-wiring') });
  const values = new Map<symbol, unknown>([
    [TOKENS.DB.symbol, {}], [TOKENS.CONFIG.symbol, {}], [TOKENS.LOGGER.symbol, useLogger('notification-wiring')],
    [TOKENS.TELEGRAM_CLIENTS.symbol, { bot: {} }], [TOKENS.HISTORY_ACCESS.symbol, access],
    [TOKENS.HISTORY_RUNTIME.symbol, runtime], [TOKENS.MEDIA_RUNTIME.symbol, { animationResolvers: new Map(), customEmojiResolvers: new Map(), animationMaxFrames: new Map(), hydrateAltText: vi.fn() }],
    [TOKENS.PIPELINE.symbol, { replayChat: vi.fn() }], [TOKENS.TELEGRAM_MANAGER.symbol, {}],
  ]);
  const factories = new Map<symbol, () => unknown>();
  const registrar = {
    get: <T>(token: Token<T>): T => { if (!values.has(token.symbol)) throw new Error('Missing test dependency'); return values.get(token.symbol) as T; },
    register: <T>(token: Token<T>, factory: () => T) => { factories.set(token.symbol, factory); },
  };
  registerMedia(registrar); registerDriver(registrar);
  factories.get(TOKENS.MEDIA_RUNTIME.symbol)!();
  factories.get(TOKENS.TELEGRAM_POST_STARTUP_TASKS.symbol)!();
  const media = vi.mocked(createMediaRuntime).mock.calls.at(-1)![0];
  const backfill = vi.mocked(createTelegramPostStartupTasks).mock.calls.at(-1)![0];
  const before = runtime.metrics().notificationItems;
  const record = { imageHash: 'emoji:7', altText: 'complete', altTextTokens: 1 };
  expect(media.persistAltText(record)).toBeUndefined();
  expect(persistImageAltText).toHaveBeenLastCalledWith({}, record);
  expect(runtime.metrics().notificationItems).toBe(before + Number(enabled));
  expect(backfill.updateEventAttachments(1, [])).toBeUndefined();
  expect(updateEventAttachments).toHaveBeenLastCalledWith({}, 1, []);
  expect(runtime.metrics().notificationItems).toBe(before + 2 * Number(enabled));
  expect(options).not.toHaveBeenCalled();
  vi.mocked(persistImageAltText).mockImplementationOnce(() => { throw new Error('core failure'); });
  expect(() => media.persistAltText({ ...record, imageHash: 'failed' })).toThrow('core failure');
  expect(runtime.metrics().notificationItems).toBe(before + 2 * Number(enabled));
  await runtime.stop();
});
