import { createReadStream, createWriteStream, unlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { Logger } from '@guiiai/logg';
import { sql } from 'drizzle-orm';
import { effect } from 'alien-signals';

import type { DB } from '../db/client';
import { insertBackgroundTask, loadBackgroundTask, loadCompletedBackgroundTasks, loadIncompleteBackgroundTasks, markBackgroundTaskCompleted, updateBackgroundTaskCheckpoint } from '../db/persistence';
import type { RuntimeTaskCompletedEvent } from '../runtime-event';
import type { RenderedContext } from '../rendering/types';
import type { ActiveTaskInfo, BackgroundTask, BackgroundTaskFactory, TaskContext } from './types';

interface ManagedTask {
  id: number;
  sessionId: string;
  typeName: string;
  intention?: string;
  timeoutMs: number;
  startedMs: number;
  task: BackgroundTask;
  factory: BackgroundTaskFactory;
  timeoutTimer: ReturnType<typeof setTimeout>;
  disposeEffect: () => void;
  completionTimer?: ReturnType<typeof setTimeout>;
  completionFlowDone: boolean;
}

interface BackgroundTaskManagerDeps {
  db: DB;
  persistEvent: (event: RuntimeTaskCompletedEvent) => void;
  pushPipelineEvent: (chatId: string, event: RuntimeTaskCompletedEvent) => RenderedContext;
  handleDriverEvent: (chatId: string, rc: RenderedContext) => void;
  taskOutputDir: string;
  retentionCount: number;
  logger: Logger;
}

const captureUtcOffset = (): number => -new Date().getTimezoneOffset();

export const createBackgroundTaskManager = (deps: BackgroundTaskManagerDeps) => {
  const log = deps.logger.withContext('bg-task');
  const factories = new Map<string, BackgroundTaskFactory>();
  const activeTasks = new Map<number, ManagedTask>();

  const registerFactory = (factory: BackgroundTaskFactory) => {
    factories.set(factory.typeName, factory);
  };

  const createRuntimeEvent = (managed: ManagedTask, finalSummary: string, hasFullOutput: boolean): RuntimeTaskCompletedEvent => {
    const now = Date.now();
    return {
      type: 'runtime',
      kind: 'task_completed',
      chatId: managed.sessionId,
      receivedAtMs: now,
      timestampSec: Math.floor(now / 1000),
      utcOffsetMin: captureUtcOffset(),
      taskId: managed.id,
      taskType: managed.typeName,
      intention: managed.intention,
      finalSummary,
      hasFullOutput,
    };
  };

  // Persist completion atomically: background_tasks.completed + RuntimeEvent
  // in a single SQLite transaction. If either fails, neither is committed.
  const persistCompletionAtomically = (managed: ManagedTask, finalSummary: string, fullOutputPath: string | null) => {
    const runtimeEvent = createRuntimeEvent(managed, finalSummary, fullOutputPath != null);
    deps.db.run(sql`BEGIN`);
    try {
      markBackgroundTaskCompleted(deps.db, managed.id, finalSummary, fullOutputPath);
      deps.persistEvent(runtimeEvent);
      deps.db.run(sql`COMMIT`);
    } catch (err) {
      deps.db.run(sql`ROLLBACK`);
      throw err;
    }
    return runtimeEvent;
  };

  const completionFlow = async (managed: ManagedTask) => {
    const { id, sessionId, typeName, task } = managed;
    const finalSummary = task.finalSummary();
    if (finalSummary == null)
      throw new Error(`Task ${id}: completed but finalSummary is null`);

    // Write fullOutput to file (async, before DB transaction)
    let fullOutputPath: string | null = null;
    const outputStream = task.streamFullOutput();
    if (outputStream) {
      fullOutputPath = `${deps.taskOutputDir}/${id}.txt`;
      await mkdir(dirname(fullOutputPath), { recursive: true });
      await pipeline(outputStream, createWriteStream(fullOutputPath));
    }

    // Atomic DB persistence: markCompleted + persistEvent in one transaction
    const runtimeEvent = persistCompletionAtomically(managed, finalSummary, fullOutputPath);
    managed.completionFlowDone = true;

    // Push through pipeline → trigger LLM call
    const rc = deps.pushPipelineEvent(sessionId, runtimeEvent);
    deps.handleDriverEvent(sessionId, rc);

    log.withFields({ id, typeName, sessionId }).log('Task completed');

    // Retention cleanup: remove oldest completed task outputs for this session
    // beyond the configured retention count.
    if (deps.retentionCount > 0) {
      const completed = loadCompletedBackgroundTasks(deps.db, sessionId);
      const toEvict = completed.slice(deps.retentionCount);
      for (const row of toEvict) {
        if (row.fullOutputPath) {
          try { unlinkSync(row.fullOutputPath); } catch {}
        }
      }
    }
  };

  const wireTaskLifecycle = (managed: ManagedTask) => {
    const { id, task, timeoutMs } = managed;

    // Timeout timer
    managed.timeoutTimer = setTimeout(() => {
      if (task.completed()) return;
      log.withFields({ id }).log('Task timed out, killing');
      task.kill('timeout');
    }, timeoutMs);

    // Watch completion via reactive effect
    managed.disposeEffect = effect(() => {
      if (!task.completed()) return;

      // Break out of sync signal graph
      managed.completionTimer = setTimeout(() => {
        void completionFlow(managed)
          .finally(() => {
            clearTimeout(managed.timeoutTimer);
            managed.disposeEffect();
            task.dispose();
            activeTasks.delete(id);
          });
      }, 0);
    });
  };

  const startTask = (
    typeName: string,
    sessionId: string,
    params: unknown,
    intention: string | undefined,
    timeoutMs: number,
  ): number => {
    const factory = factories.get(typeName);
    if (!factory) throw new Error(`Unknown background task type: ${typeName}`);

    const now = Date.now();
    const id = insertBackgroundTask(deps.db, {
      sessionId,
      typeName,
      intention,
      timeoutMs,
      params,
      startedMs: now,
    });

    const ctx: TaskContext = {
      id,
      logger: log.withContext(`task:${id}`),
    };

    const task = factory.start(ctx, params);

    const managed: ManagedTask = {
      id,
      sessionId,
      typeName,
      intention,
      timeoutMs,
      startedMs: now,
      task,
      factory,
      timeoutTimer: undefined!,
      disposeEffect: undefined!,
      completionFlowDone: false,
    };

    activeTasks.set(id, managed);
    wireTaskLifecycle(managed);

    log.withFields({ id, typeName, sessionId, timeoutMs }).log('Task started');
    return id;
  };

  const recoverTasks = () => {
    const rows = loadIncompleteBackgroundTasks(deps.db);
    for (const row of rows) {
      const factory = factories.get(row.typeName);
      if (!factory) {
        log.withFields({ id: row.id, typeName: row.typeName }).error('No factory registered for task type, skipping recovery');
        continue;
      }

      const ctx: TaskContext = {
        id: row.id,
        logger: log.withContext(`task:${row.id}`),
      };

      const task = factory.recover(ctx, row.params, row.checkpoint);

      const managed: ManagedTask = {
        id: row.id,
        sessionId: row.sessionId,
        typeName: row.typeName,
        intention: row.intention ?? undefined,
        timeoutMs: row.timeoutMs,
        startedMs: row.startedMs,
        task,
        factory,
        timeoutTimer: undefined!,
        disposeEffect: undefined!,
        completionFlowDone: false,
      };

      activeTasks.set(row.id, managed);
      wireTaskLifecycle(managed);

      log.withFields({ id: row.id, typeName: row.typeName }).log('Task recovered');
    }
  };

  const killTask = (taskId: number, reason: 'timeout' | 'tool_call'): { ok: boolean; error?: string } => {
    const managed = activeTasks.get(taskId);
    if (!managed) return { ok: false, error: `No active task with id ${taskId}` };
    if (managed.task.completed()) return { ok: false, error: `Task ${taskId} is already completed` };
    managed.task.kill(reason);
    return { ok: true };
  };

  const getActiveTasks = (sessionId: string): ActiveTaskInfo[] => {
    const result: ActiveTaskInfo[] = [];
    for (const managed of activeTasks.values()) {
      if (managed.sessionId !== sessionId) continue;
      if (managed.task.completed()) continue;
      result.push({
        id: managed.id,
        typeName: managed.typeName,
        intention: managed.intention,
        liveSummary: managed.task.renderLiveSummary(),
        startedMs: managed.startedMs,
        timeoutMs: managed.timeoutMs,
      });
    }
    return result;
  };

  // Read task output with real line-based pagination via streaming.
  // Returns a Promise because it uses readline to avoid loading the entire
  // file into memory (large command outputs can be many MB).
  const readTaskOutput = async (taskId: number, offset = 0, limit = 200): Promise<{ content: string; totalLines: number; truncated: boolean } | { error: string }> => {
    const row = loadBackgroundTask(deps.db, taskId);
    if (!row) return { error: `No task with id ${taskId}` };
    if (!row.completed) return { error: `Task ${taskId} is still running. Check its live summary in the prompt.` };

    if (!row.fullOutputPath) {
      const summary = row.finalSummary ?? '';
      const lines = summary.split('\n');
      const slice = lines.slice(offset, offset + limit);
      return { content: slice.join('\n'), totalLines: lines.length, truncated: offset + limit < lines.length };
    }

    // Stream through the file line by line — never loads entire file into memory.
    let totalLines = 0;
    const collected: string[] = [];
    const rl = createInterface({ input: createReadStream(row.fullOutputPath, 'utf-8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (totalLines >= offset && collected.length < limit)
        collected.push(line);
      totalLines++;
    }

    return { content: collected.join('\n'), totalLines, truncated: offset + limit < totalLines };
  };

  const shutdown = () => {
    for (const managed of activeTasks.values()) {
      clearTimeout(managed.timeoutTimer);
      if (managed.completionTimer) clearTimeout(managed.completionTimer);
      managed.disposeEffect();

      if (managed.task.completed() && !managed.completionFlowDone) {
        // Task completed during this runtime but the async completion flow was
        // still pending (setTimeout(0) hadn't fired yet, or file write was in
        // progress). Persist the DB records synchronously — fullOutput file may
        // be incomplete but the task result is not lost.
        const finalSummary = managed.task.finalSummary()!;
        persistCompletionAtomically(managed, finalSummary, null);
        managed.completionFlowDone = true;
        log.withFields({ id: managed.id }).log('Flushed pending completion during shutdown');
      } else if (!managed.task.completed()) {
        // Task still running — kill the OS process and persist checkpoint.
        const checkpoint = managed.task.pause();
        updateBackgroundTaskCheckpoint(deps.db, managed.id, checkpoint, Date.now());
      }

      managed.task.dispose();
    }
    activeTasks.clear();
    log.log('All background tasks shut down');
  };

  return {
    registerFactory,
    startTask,
    recoverTasks,
    killTask,
    getActiveTasks,
    readTaskOutput,
    shutdown,
  };
};

export type BackgroundTaskManager = ReturnType<typeof createBackgroundTaskManager>;
