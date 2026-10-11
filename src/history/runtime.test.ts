import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHistoryAccess } from './access';
import { createHistoryDelivery } from './delivery';
import type { HistoryDelivery } from './notifications';
import { createHistoryRuntime } from './runtime';

initLogger(LogLevel.Error, Format.Pretty);
afterEach(() => vi.useRealTimers());
const fakeChild = () => {
  const emitter = new EventEmitter();
  const send = vi.fn((_message, callback) => { callback?.(undefined); return true; });
  const kill = vi.fn(() => true);
  return Object.assign(emitter, { connected: true, send, kill }) as unknown as ChildProcess;
};
const flush = async () => { await Promise.resolve(); };

describe('asynchronous history delivery and lifecycle', () => {
  it('resolves no worker options and sends no notifications when globally disabled', async () => {
    vi.useFakeTimers();
    const options = vi.fn(() => { throw new Error('Disabled history must not resolve worker options'); });
    const spawn = vi.fn(() => fakeChild());
    const runtime = createHistoryRuntime({ access: createHistoryAccess({ enabled: false }), options, logger: useLogger('test'), spawn });
    runtime.start(); runtime.notifyMedia('events', '1');
    await vi.advanceTimersByTimeAsync(10000);
    await runtime.stop(); await runtime.stop();
    expect(options).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    expect(runtime.metrics()).toMatchObject({ enabled: false, notificationItems: 0, sent: 0, running: false });
  });

  it('defers failing options and spawn work outside startup and stops their independent retries', async () => {
    vi.useFakeTimers();
    const options = vi.fn(() => { throw new Error('invalid History options'); });
    const spawn = vi.fn(() => fakeChild());
    const runtime = createHistoryRuntime({ access: createHistoryAccess({ enabled: true }), options, logger: useLogger('test'), spawn, restartMs: 10 });
    expect(runtime.start()).toBeUndefined();
    expect(options).not.toHaveBeenCalled();
    expect(runtime.notifyMedia('events', '1')).toBeUndefined();
    await flush(); expect(options).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10); expect(options).toHaveBeenCalledTimes(2);
    await runtime.stop(); await vi.advanceTimersByTimeAsync(100);
    expect(options).toHaveBeenCalledTimes(2); expect(spawn).not.toHaveBeenCalled();
    const stopped = createHistoryRuntime({ access: createHistoryAccess({ enabled: true }), options, logger: useLogger('test'), spawn });
    stopped.start(); await stopped.stop(); await flush();
    expect(options).toHaveBeenCalledTimes(2);
  });

  it('keeps producer calls synchronous through unavailable/throwing IPC, receipt retries and finite shutdown', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const children = [child, fakeChild()];
    const spawn = vi.fn(() => children.shift()!);
    const runtime = createHistoryRuntime({ access: createHistoryAccess({ enabled: true }), options: () => ({ archivePath: '/archive.db', historyPath: '/history.db' }), logger: useLogger('test'), spawn, restartMs: 10, shutdownMs: 20 });
    expect(runtime.start()).toBeUndefined();
    expect(runtime.notifyMedia('events', '1')).toBeUndefined();
    await flush(); expect(child.send).not.toHaveBeenCalled();
    child.emit('message', { kind: 'ready' });
    vi.mocked(child.send).mockImplementation(() => { throw new Error('offline'); });
    expect(runtime.notifyMedia('events', '2')).toBeUndefined();
    await flush(); expect(child.send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.send).toHaveBeenCalledTimes(2);
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10); expect(spawn).toHaveBeenCalledTimes(2);
    const replacement = spawn.mock.results[1]!.value;
    replacement.emit('message', { kind: 'ready' }); await flush();
    expect(replacement.send).toHaveBeenCalled();
    expect(runtime.metrics().notificationItems).toBe(2);
    const stopped = runtime.stop();
    expect(replacement.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(20); expect(replacement.kill).toHaveBeenCalledWith('SIGKILL');
    replacement.emit('exit', null, 'SIGKILL'); await stopped;
    runtime.notifyMedia('events', '3'); await vi.advanceTimersByTimeAsync(2000);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(runtime.metrics()).toMatchObject({ notificationItems: 0, ready: false });
  });

  it('bounds delivery memory and preserves overflow recovery until durable ACK, including a last unseen completion', async () => {
    vi.useFakeTimers();
    const frames: HistoryDelivery[] = [];
    const delivery = createHistoryDelivery({ send: (message, done) => { frames.push(message); done(null); }, onError: vi.fn(), maxItems: 2, maxBytes: 1000, retryMs: 10 });
    delivery.connect(); await flush();
    const first = frames[0]!;
    for (let i = 1; i <= 1000; i++) delivery.offer({ kind: 'media', sourceKind: 'events', sourceKey: String(i) });
    expect(delivery.metrics().notificationItems).toBeLessThanOrEqual(2);
    expect(delivery.metrics().notificationBytes).toBeLessThanOrEqual(1000);
    delivery.acknowledge(first.id); await flush();
    const recovery = frames.at(-1)!;
    expect(recovery.input.kind).toBe('recover');
    await vi.advanceTimersByTimeAsync(10);
    expect(frames.at(-1)!.id).toBe(recovery.id);
    expect(delivery.metrics().recoveryRequested).toBe(true);
    delivery.acknowledge(recovery.id); await flush();
    expect(delivery.metrics().recoveryRequested).toBe(false);
    while (delivery.metrics().awaitingReceipt) { delivery.acknowledge(frames.at(-1)!.id); await flush(); }
    expect(delivery.metrics().notificationItems).toBe(0);
    delivery.stop();
  });

  it('retains a newer same-target notice across an old receipt and bounds a saturated transport to one write', async () => {
    vi.useFakeTimers();
    const frames: HistoryDelivery[] = [];
    let done!: (error: Error | null) => void;
    const delivery = createHistoryDelivery({ send: (message, callback) => { frames.push(message); done = callback; }, onError: vi.fn(), retryMs: 10 });
    delivery.connect(); await flush();
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(10);
    expect(frames).toHaveLength(1);
    done(null); delivery.acknowledge(frames[0]!.id); await flush();
    delivery.offer({ kind: 'media', sourceKind: 'events', sourceKey: '1' }); await flush();
    const old = frames.at(-1)!;
    delivery.offer({ kind: 'media', sourceKind: 'events', sourceKey: '1' });
    done(null); delivery.acknowledge(old.id); await flush();
    expect(delivery.metrics().notificationItems).toBe(1);
    expect(frames.at(-1)!.id).not.toBe(old.id);
    delivery.disconnect(); delivery.connect(); await flush();
    expect(frames.at(-1)!.input.kind).toBe('recover');
    delivery.stop();
  });
});
