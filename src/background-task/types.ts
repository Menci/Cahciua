import type { Logger } from '@guiiai/logg';
import type { Readable } from 'node:stream';

export interface BackgroundTaskFactory<TParams = unknown, TCheckpoint = unknown> {
  readonly typeName: string;

  /** Start a new task. The returned BackgroundTask is a live reactive object. */
  start(ctx: TaskContext, params: TParams): BackgroundTask;

  /**
   * Recover a task from persisted state.
   *
   * checkpoint is null if the task was never successfully paused (e.g., crash).
   *
   * Contract: Factory MUST validate checkpoint consistency with actual state.
   * If the checkpoint is stale or inconsistent (e.g., referenced temp files are
   * missing, or actual progress went further than the checkpoint records), the
   * factory should immediately complete with a finalSummary explaining the
   * inconsistency. Factory MUST NOT silently resume from an inconsistent checkpoint.
   */
  recover(ctx: TaskContext, params: TParams, checkpoint: TCheckpoint | null): BackgroundTask;
}

export interface TaskContext {
  readonly id: number;
  readonly logger: Logger;
}

export interface BackgroundTask {
  /** Reactive: whether the task has completed (signal getter). */
  readonly completed: () => boolean;

  /** Available when completed = true. */
  readonly finalSummary: () => string | undefined;

  /** Render current status summary for late-binding prompt. Reads internal state. */
  renderLiveSummary(): string;

  /**
   * Stream full output after completion. Returns null if finalSummary IS the
   * complete output. Only valid when completed = true.
   */
  streamFullOutput(): Readable | null;

  /**
   * Atomically pause the task and dump internal state for persistence.
   * Called only during shutdown. After pause(), the task is suspended (NOT completed).
   * The returned value is serialized to JSON and stored as the checkpoint.
   */
  pause(): unknown;

  /**
   * Force-terminate the task. The implementation MUST eventually set
   * completed to true after receiving this call.
   */
  kill(reason: 'timeout' | 'tool_call'): void;

  /**
   * Release resources held by the BackgroundTask object itself.
   * Called by Manager after completion flow finishes, or after pause + persist.
   * Called exactly once.
   */
  dispose(): void;
}

export interface ActiveTaskInfo {
  id: number;
  typeName: string;
  intention?: string;
  liveSummary: string;
  startedMs: number;
  timeoutMs: number;
}
