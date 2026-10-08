import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { expect, it, vi } from 'vitest';

vi.mock('../../driver', () => ({ createDriver: vi.fn() }));
vi.mock('../../telegram/moderation-api', () => ({ createModerationApi: vi.fn() }));
vi.mock('../../telegram/moderation', () => ({ createModerationService: () => ({ banSpammer: vi.fn() }) }));

import { registerDriver } from './driver';
import { createDriver } from '../../driver';
import { createPipeline } from '../../pipeline';
import type { Token } from '../tokens';
import { TOKENS } from '../tokens';

initLogger(LogLevel.Error, Format.Pretty);

it('maps Driver compaction to an online window only for a resident chat', () => {
  const pipeline = createPipeline({});
  const values = new Map<symbol, unknown>([
    [TOKENS.PIPELINE.symbol, pipeline],
    [TOKENS.CONFIG.symbol, {}],
    [TOKENS.RUNTIME_CONFIG.symbol, {}],
    [TOKENS.CHAT_IDS.symbol, []],
    [TOKENS.DB.symbol, {}],
    [TOKENS.LOGGER.symbol, useLogger('driver-registration-test')],
    [TOKENS.TELEGRAM_DRIVER_HOOKS.symbol, {}],
    [TOKENS.BACKGROUND_TASK_MANAGER.symbol, {}],
    [TOKENS.TELEGRAM_EVENT_SINK.symbol, {}],
    [TOKENS.TELEGRAM_CLIENTS.symbol, { bot: { raw: () => ({}), botUserId: () => 'bot' } }],
  ]);
  const factories = new Map<symbol, () => unknown>();
  registerDriver({
    get: <T>(token: Token<T>): T => {
      if (!values.has(token.symbol)) throw new Error('Missing test dependency');
      return values.get(token.symbol) as T;
    },
    register: (token, factory) => { factories.set(token.symbol, factory); },
  });
  factories.get(TOKENS.DRIVER.symbol)!();
  const deps = vi.mocked(createDriver).mock.calls.at(-1)![1];
  expect(() => deps.setCompactCursor('missing', 2000)).toThrow('Cannot compact non-resident chat missing');
  expect(pipeline.getRenderWindow('missing')).toBeUndefined();
  // Empty replay is still resident; startup may seed a window before this replay.
  pipeline.setRenderWindow('chat', { fromReceivedAtMs: 1000 });
  pipeline.replayChat('chat', []);
  deps.setCompactCursor('chat', 2000);
  expect(pipeline.getRenderWindow('chat')).toEqual({ fromReceivedAtMs: 2000 });
});
