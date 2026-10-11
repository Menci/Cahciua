import type { HistoryDelivery, HistoryNotification } from './notifications';

// This adapter owns only bounded delivery memory. Durable source cursors and
// pending targets, including recovery of its last lost frame, belong to History.
export const createHistoryDelivery = (deps: {
  send: (message: HistoryDelivery, onError: (error: Error | null) => void) => void;
  onError: (error: unknown) => void;
  retryMs?: number;
  maxItems?: number;
  maxBytes?: number;
}) => {
  const pending = new Map<string, { input: HistoryNotification; version: number; bytes: number }>();
  let bytes = 0;
  let version = 0;
  let recovery = 0;
  let ready = false;
  let stopped = false;
  let queued = false;
  let writing = false;
  let connection = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: { message: HistoryDelivery; key?: string; version: number } | undefined;
  let sent = 0;
  let acknowledged = 0;
  let recoveries = 0;
  const schedule = () => {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(() => { queued = false; pump(); });
  };
  const pump = () => {
    if (stopped || !ready) return;
    if (!inflight) {
      if (recovery) inflight = { message: { kind: 'history-input', id: ++version, input: { kind: 'recover' } }, version: recovery };
      else {
        const next = pending.entries().next().value;
        if (!next) return;
        inflight = { message: { kind: 'history-input', id: ++version, input: next[1].input }, key: next[0], version: next[1].version };
      }
    }
    clearTimeout(timer);
    // One outstanding frame bounds Node's IPC backlog. Retries wait for durable
    // receipt, not for construction, and never run in a producer's call stack.
    timer = setTimeout(pump, deps.retryMs ?? 1000);
    timer.unref();
    if (writing) return;
    const epoch = connection;
    writing = true;
    try {
      sent++;
      deps.send(inflight.message, error => {
        if (epoch !== connection) return;
        writing = false;
        if (error && !stopped) deps.onError(error);
      });
    } catch (error) { writing = false; deps.onError(error); }
  };
  return {
    offer(input: HistoryNotification): void {
      if (stopped) return;
      if (input.kind === 'recover') { recovery = ++version; recoveries++; schedule(); return; }
      const key = JSON.stringify([input.sourceKind, input.sourceKey]);
      const size = Buffer.byteLength(key) + 128;
      const previous = pending.get(key);
      if (Buffer.byteLength(input.sourceKey) > 1024 || (!previous && pending.size >= (deps.maxItems ?? 128)) || bytes - (previous?.bytes ?? 0) + size > (deps.maxBytes ?? 64 * 1024)) {
        pending.clear(); bytes = 0;
        recovery = ++version; recoveries++;
      } else {
        pending.set(key, { input, version: ++version, bytes: size });
        bytes += size - (previous?.bytes ?? 0);
      }
      schedule();
    },
    connect(): void {
      if (stopped) return;
      ready = true; connection++; writing = false; inflight = undefined; recovery = ++version; recoveries++;
      clearTimeout(timer); schedule();
    },
    disconnect(): void { ready = false; connection++; writing = false; inflight = undefined; clearTimeout(timer); },
    acknowledge(id: number): void {
      if (stopped || inflight?.message.id !== id) return;
      if (inflight.key) {
        const current = pending.get(inflight.key);
        if (current?.version === inflight.version) { pending.delete(inflight.key); bytes -= current.bytes; }
      } else if (recovery === inflight.version) recovery = 0;
      inflight = undefined; acknowledged++; clearTimeout(timer); schedule();
    },
    stop(): void { stopped = true; ready = false; pending.clear(); bytes = 0; inflight = undefined; clearTimeout(timer); },
    metrics: () => ({ notificationItems: pending.size, notificationBytes: bytes, recoveryRequested: !!recovery, awaitingReceipt: !!inflight, sent, acknowledged, recoveries, ready }),
  };
};
