import { Format, initLogger, LogLevel, useGlobalLogger } from '@guiiai/logg';

export function setupLogger() {
  const isDev = process.env.NODE_ENV !== 'production';
  initLogger(
    isDev ? LogLevel.Debug : LogLevel.Log,
    isDev ? Format.Pretty : Format.JSON,
  );
}

export function useLogger(context: string) {
  return useGlobalLogger(context);
}
