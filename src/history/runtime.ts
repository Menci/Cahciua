import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger } from '@guiiai/logg';

import type { RenderParams } from '../rendering';
import type { HistoryAccess } from './access';
import { createHistoryDelivery } from './delivery';
import type { HistoryMediaSource } from './notifications';
import type { HistoryWorkerOptions } from './worker';

export const createHistoryRuntime = (deps: {
  access: HistoryAccess;
  options: () => HistoryWorkerOptions;
  logger: Logger;
  restartMs?: number;
  shutdownMs?: number;
  spawn?: (entry: string, args: readonly string[]) => ChildProcess;
}) => {
  const log = deps.logger.withContext('history');
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let started = false;
  let options: HistoryWorkerOptions | undefined;
  let stopPromise: Promise<void> | undefined;
  const delivery = createHistoryDelivery({
    send: (message, callback) => {
      if (!child?.connected) { callback(new Error('History IPC disconnected')); return; }
      child.send(message, callback);
    },
    onError: error => log.withError(error).warn('History input delivery failed; retrying independently'),
  });
  const launch = () => {
    if (stopped || !options || !deps.access.enabled) return;
    delivery.disconnect();
    const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './history-worker.mjs', import.meta.url));
    let current: ChildProcess;
    try {
      current = (deps.spawn ?? ((path, args) => fork(path, [...args], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })))(entry, ['--history-worker', JSON.stringify(options)]);
    } catch (error) {
      log.withError(error).error('History spawn failed; retrying independently');
      timer = setTimeout(launch, deps.restartMs ?? 5000);
      return;
    }
    child = current;
    current.on('message', (value: unknown) => {
      if (stopped || child !== current || !value || typeof value !== 'object' || !('kind' in value)) return;
      if (value.kind === 'ready') delivery.connect();
      if (value.kind === 'received' && 'id' in value && typeof value.id === 'number') delivery.acknowledge(value.id);
    });
    current.on('disconnect', () => { if (child === current) delivery.disconnect(); });
    current.on('error', error => log.withError(error).error('History child error'));
    current.once('exit', (code, signal) => {
      if (child !== current) return;
      child = undefined;
      delivery.disconnect();
      if (!stopped) {
        log.withFields({ code, signal }).warn('History child exited; restarting with saved progress');
        timer = setTimeout(launch, deps.restartMs ?? 5000);
      }
    });
  };
  return {
    start(params: RenderParams = {}): void {
      if (!deps.access.enabled || started || stopped) return;
      started = true;
      const renderParams = { botUserId: params.botUserId, contactNames: [...(params.contactNames ?? [])] };
      const prepare = () => {
        if (stopped) return;
        try { options = { ...deps.options(), renderParams }; } catch (error) {
          log.withError(error).error('History options failed; retrying independently');
          timer = setTimeout(prepare, deps.restartMs ?? 5000);
          return;
        }
        launch();
      };
      queueMicrotask(prepare);
    },
    notifyMedia(sourceKind: HistoryMediaSource, sourceKey: string): void {
      if (!deps.access.enabled || stopped) return;
      delivery.offer({ kind: 'media', sourceKind, sourceKey });
    },
    metrics: () => ({ enabled: deps.access.enabled, ...delivery.metrics(), running: !!child }),
    stop(): Promise<void> {
      stopPromise ??= (async () => {
        stopped = true;
        clearTimeout(timer);
        delivery.stop();
        const current = child;
        if (!current) return;
        await new Promise<void>(resolveStop => {
          const killTimer = setTimeout(() => { current.kill('SIGKILL'); }, deps.shutdownMs ?? 2000);
          current.once('exit', () => { clearTimeout(killTimer); resolveStop(); });
          current.kill('SIGTERM');
        });
      })();
      return stopPromise;
    },
  };
};
export type HistoryRuntime = ReturnType<typeof createHistoryRuntime>;

export const defaultHistoryOptions = (archivePath: string): HistoryWorkerOptions => ({
  archivePath: resolve(archivePath),
  historyPath: process.env.CAHCIUA_HISTORY_PATH ?? resolve(archivePath, '../history.db'),
  limits: process.env.CAHCIUA_HISTORY_LIMITS ? JSON.parse(process.env.CAHCIUA_HISTORY_LIMITS) as HistoryWorkerOptions['limits'] : undefined,
});
