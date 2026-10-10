import { setTimeout as delay } from 'node:timers/promises';

import type { ArchivedCompaction, ArchivedEvent, HistoryArchive, HistorySource } from '../db/history-archive';
import { createEmptyIC, reduce } from '../projection';
import type { PipelineEvent } from '../projection';
import { projectionDependencies } from '../projection/dependencies';
import type { RenderParams } from '../rendering';
import { checkHistoryLimits, createWorkspaceBudget, defaultHistoryLimits } from './budget';
import type { HistoryLimits, WorkspaceBudget } from './budget';
import { eventCacheKeys } from './media-dependencies';
import { buildMessageItems, changedMessageIds, updateMessageSource } from './message-items';
import type { MessageSource } from './message-items';
import { describeSource } from './source-observer';
import type { HistoryCheckpoint, HistoryCommit, HistoryStore } from './store';
import { buildTurnItems, historyKey } from './turn-items';
import type { HistoryBatch, HistoryItem } from './types';

export const summaryItem = (row: ArchivedCompaction): HistoryItem => ({
  kind: 'summary', key: historyKey(row.ref.chatId, 'summary', row.ref.id), chatId: row.ref.chatId,
  source: row.ref, sourceRevision: row.revision,
  order: { timeMs: row.createdAtMs, sourceOrder: 2, sourceId: row.ref.id, entryIndex: -1, partIndex: -1 },
  summary: row.summary, compactionId: row.ref.id, createdAtMs: row.createdAtMs,
  coverage: { fromReceivedAtMs: row.oldCursorMs, untilReceivedAtMs: row.newCursorMs },
});

export const projectEvent = (deps: {
  store: HistoryStore;
  generation: string;
  row: ArchivedEvent;
  budget: WorkspaceBudget;
  renderParams?: RenderParams;
}): Pick<HistoryCommit, 'messages' | 'users' | 'chatTitle' | 'event' | 'dependencies'> & Pick<HistoryBatch, 'changes' | 'notices'> => {
  const { store, generation, row, budget } = deps;
  const chatId = row.ref.chatId;
  const dependencies = projectionDependencies(row.event);
  let ic = createEmptyIC(chatId);
  const sources = new Map<string, MessageSource>();
  ic.chatTitle = store.loadChatTitle(generation, chatId, budget);
  for (const id of dependencies.messageIds) {
    const state = store.loadMessage(generation, chatId, id, budget);
    if (state) {
      ic.nodes.push(state.node);
      sources.set(id, state.source);
    }
  }
  for (const id of dependencies.userIds) {
    const state = store.loadUser(generation, chatId, id, budget);
    if (state) ic.users.set(id, state);
  }
  ic = reduce(ic, row.event);
  const touched = new Set(changedMessageIds(row));
  const messages: NonNullable<HistoryCommit['messages']>[number][] = [];
  for (const node of ic.nodes) {
    if (node.type !== 'message' || !touched.has(node.messageId)) continue;
    const previous = sources.get(node.messageId);
    const source = updateMessageSource(previous, row);
    if (!source) throw new Error('Missing historical message source');
    sources.set(node.messageId, source);
    messages.push({ node, source, parentRevision: previous?.revision });
  }
  const items: HistoryItem[] = buildMessageItems({ ...ic, nodes: messages.map(state => state.node) }, sources, deps.renderParams);
  const notices: HistoryBatch['notices'][number][] = [];
  if (row.event.type === 'runtime') {
    const { tool, count } = store.loadTask(generation, chatId, row.event.taskId, budget);
    if (tool) items.push({
      ...tool, completion: {
        source: row.ref, sourceRevision: row.revision, taskId: row.event.taskId,
        taskType: row.event.taskType, finalSummary: row.event.finalSummary, hasFullOutput: row.event.hasFullOutput,
      },
    });
    else notices.push({ kind: count > 1 ? 'ambiguous-task-completion' : 'unlinked-task-completion', source: row.ref, taskId: row.event.taskId });
  }
  return {
    messages, users: [...ic.users].map(([id, state]) => ({ id, state })), chatTitle: ic.chatTitle, event: row,
    dependencies: messages.map(state => ({ messageId: state.node.messageId, cacheKeys: eventCacheKeys(row.event) })),
    changes: items.map(item => ({ operation: 'upsert', item })), notices,
  };
};

export interface BootstrapDeps {
  readonly archive: HistoryArchive;
  readonly store: HistoryStore;
  readonly generation: string;
  readonly chatId: string;
  readonly archiveIdentity: string;
  // Include cache/display policy changes in this identity. Changed policies
  // require an explicit rebuild generation; fences cannot reconcile cache edits.
  readonly renderIdentity: string;
  readonly renderParams?: RenderParams;
  readonly compactionsById?: boolean;
  readonly hydrateAltText?: (event: PipelineEvent, reserve: (bytes: number) => void) => void;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<HistoryLimits>;
}
export interface BootstrapSlice {
  readonly processedRows: number;
  readonly scanComplete: boolean;
  readonly peakStateEntries: number;
  readonly peakEncodedWorkspaceBytes: number;
}

// A slice retains at most one decoded source and its indexed dependencies.
// Every row is a batch/transaction; maxRowsPerSlice caps scheduling work, not IC
// residency. Reopening this process restores only the next row's dependencies.
export const buildHistorySlice = async (deps: BootstrapDeps): Promise<BootstrapSlice> => {
  const { archive, store, generation, chatId } = deps;
  const limits = { ...defaultHistoryLimits, ...deps.limits };
  checkHistoryLimits(limits);
  // Capture only on the first slice; initialize deliberately preserves fences.
  store.initialize(generation, deps.archiveIdentity, deps.renderIdentity, chatId, () => archive.captureBounds(chatId));
  let processedRows = 0;
  let peakStateEntries = 0;
  let peakEncodedWorkspaceBytes = 0;
  // TRs precede events so all explicit task starts are available on disk. Every
  // summary remains a separate source item and has its own durable checkpoint.
  const sources: readonly HistorySource[] = ['turn_responses_v2', 'events', 'compactions'];
  for (const source of sources) {
    for (;;) {
      const expected: HistoryCheckpoint = store.checkpoint(generation, chatId, source);
      if (expected.done) break;
      if (deps.signal?.aborted || processedRows >= limits.maxRowsPerSlice) return { processedRows, scanComplete: false, peakStateEntries, peakEncodedWorkspaceBytes };
      const started = performance.now();
      const request = { bounds: expected.bounds, after: expected.after, limit: 1, maxBytes: Math.min(limits.maxSourceBytes, limits.maxWorkspaceBytes) };
      const budget = createWorkspaceBudget(limits);
      let plan: HistoryCommit;
      try {
        if (source === 'events') {
          const page = archive.readEvents(request);
          const row = page.rows[0];
          if (row) {
            deps.hydrateAltText?.(row.event, bytes => budget.reserve(bytes));
            budget.reserve(Buffer.byteLength(JSON.stringify(row)));
          }
          // Applied target revisions are durable sub-event progress. A crash
          // resumes the same delete without loading its entire target set.
          const target = row?.event.type === 'delete' ? store.sqlite.prepare(`SELECT state.message_id AS id
            FROM json_each(?) AS target JOIN history_message_states AS state
              ON state.generation = ? AND state.chat_id = ? AND state.message_id = target.value
            LEFT JOIN history_message_revisions AS revision ON revision.generation = state.generation
              AND revision.chat_id = state.chat_id AND revision.message_id = state.message_id AND revision.event_id = ?
            WHERE revision.event_id IS NULL LIMIT 1`).get(JSON.stringify(row.event.messageIds), generation, chatId, row.ref.id) as { id: string } | undefined : undefined;
          const partial = target !== undefined;
          const effective = row?.event.type === 'delete' ? { ...row, event: { ...row.event, messageIds: target ? [target.id] : [] } } : row;
          const projected = effective ? projectEvent({ ...deps, row: effective, budget }) : { changes: [], notices: [] };
          plan = {
            generation, expected, ...projected, event: row, partial, observation: row ? describeSource(row) : undefined, batch: {
              changes: projected.changes, notices: projected.notices,
              progress: { bounds: expected.bounds, source, after: partial ? expected.after : page.next ?? expected.after, done: !partial && page.done },
            },
          };
        } else if (source === 'turn_responses_v2') {
          const page = await archive.readTurns(request);
          const row = page.rows[0];
          if (row) {
            if (row.encodedBytes === undefined) throw new Error('History archive omitted byte preflight');
            budget.reserve(row.encodedBytes);
          }
          const items = row ? buildTurnItems(row, limits.maxOutputItems) : [];
          // Source preflight includes encoded images. Historical decoding omits
          // their custom values; saved items retain positions without media handles.
          plan = {
            generation, expected, observation: row ? describeSource(row) : undefined, batch: {
              changes: items.map(item => ({ operation: 'upsert', item })), notices: [],
              progress: { bounds: expected.bounds, source, after: page.next ?? expected.after, done: page.done },
            },
          };
        } else {
          const page = archive.readCompactions({ ...request, compactionsById: deps.compactionsById });
          const row = page.rows[0];
          if (row) budget.reserve(Buffer.byteLength(JSON.stringify(row)));
          plan = {
            generation, expected, observation: row ? describeSource(row) : undefined, batch: {
              changes: row ? [{ operation: 'upsert', item: summaryItem(row) }] : [], notices: [],
              progress: { bounds: expected.bounds, source, after: page.next ?? expected.after, done: page.done },
            },
          };
        }
        if (plan.batch.changes.length > limits.maxOutputItems) throw new Error(`History output exceeds item budget (${limits.maxOutputItems}); cursor unchanged`);
        budget.reserve(Buffer.byteLength(JSON.stringify(plan)));
        store.commit(plan);
      } catch (cause) {
        throw new Error(`History bootstrap failed: generation=${generation} chat=${chatId} source=${source} after=${JSON.stringify(expected.after ?? null)}`, { cause });
      }
      peakStateEntries = Math.max(peakStateEntries, budget.entries);
      peakEncodedWorkspaceBytes = Math.max(peakEncodedWorkspaceBytes, budget.encodedBytes);
      if (plan.partial || plan.batch.progress.after?.id !== expected.after?.id) processedRows++;
      // Only this row's plan survives through the wait; no cross-row cache exists.
      // Await even when processing is slow to yield the event loop to shutdown.
      await delay(Math.max(1, Math.ceil(1000 / limits.rowsPerSecond - (performance.now() - started))));
    }
  }
  return { processedRows, scanComplete: true, peakStateEntries, peakEncodedWorkspaceBytes };
};
