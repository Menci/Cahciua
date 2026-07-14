import type { Logger } from '@guiiai/logg';

import type { createBackgroundTaskManager } from '../background-task/manager';
import type { BackgroundTasksConfig, Config, RuntimeConfig } from '../config/config';
import type { DB } from '../db/client';
import type { createDriver } from '../driver';
import type { DriverInputBus } from '../driver/input-bus';
import type { MediaRuntime } from '../media/runtime';
import type { createPipeline } from '../pipeline';
import type { TelegramDriverHooks, TelegramEventSink, TelegramLiveHandlers, TelegramManager, TelegramPostStartupTasks } from '../telegram';
import type { TelegramClients } from '../telegram/manager';

declare const tokenType: unique symbol;

export interface Token<T> {
  readonly symbol: symbol;
  readonly [tokenType]?: (_: T) => T;
}

const token = <T>(name: string): Token<T> => ({ symbol: Symbol(name) });

export const TOKENS = {
  LOGGER: token<Logger>('Logger'),
  CONFIG: token<Config>('Config'),
  RUNTIME_CONFIG: token<RuntimeConfig>('RuntimeConfig'),
  BACKGROUND_TASKS_CONFIG: token<BackgroundTasksConfig>('BackgroundTasksConfig'),
  CHAT_IDS: token<string[]>('ChatIds'),
  CONFIGURED_CHAT_IDS: token<ReadonlySet<string>>('ConfiguredChatIds'),
  DB: token<DB>('Database'),
  TELEGRAM_CLIENTS: token<TelegramClients>('TelegramClients'),
  MEDIA_RUNTIME: token<MediaRuntime>('MediaRuntime'),
  TELEGRAM_MANAGER: token<TelegramManager>('TelegramManager'),
  PIPELINE: token<ReturnType<typeof createPipeline>>('Pipeline'),
  DRIVER_INPUT_BUS: token<DriverInputBus>('DriverInputBus'),
  TELEGRAM_EVENT_SINK: token<TelegramEventSink>('TelegramEventSink'),
  TELEGRAM_DRIVER_HOOKS: token<TelegramDriverHooks>('TelegramDriverHooks'),
  BACKGROUND_TASK_MANAGER: token<ReturnType<typeof createBackgroundTaskManager>>('BackgroundTaskManager'),
  DRIVER: token<ReturnType<typeof createDriver>>('Driver'),
  TELEGRAM_LIVE_HANDLERS: token<TelegramLiveHandlers>('TelegramLiveHandlers'),
  TELEGRAM_POST_STARTUP_TASKS: token<TelegramPostStartupTasks>('TelegramPostStartupTasks'),
} as const;
