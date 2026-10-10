import { and, asc, eq, sql } from 'drizzle-orm';

import { createHistoryChanges, createSourceObserver } from './source-observer';
import type { HistorySourceChange } from './source-observer';
import type { HistoryArchive } from '../db/history-archive';
import type { PipelineEvent } from '../projection';
import { createEmptyIC } from '../projection';
import type { RenderParams } from '../rendering';
import { buildHistorySlice, summaryItem } from './bootstrap';
import { checkHistoryLimits, createWorkspaceBudget, defaultHistoryLimits } from './budget';
import type { HistoryLimits } from './budget';
import { createIndexedHistoryArchive } from './indexed-archive';
import { buildMessageItems } from './message-items';
import { restoreMessage } from './restore-message';
import * as schema from './schema';
import { HISTORY_PROJECTION_VERSION } from './store';
import type { HistoryConsumeCommit, HistoryStore } from './store';
import { startedTaskId } from './task-items';
import { buildTurnItems } from './turn-items';
import type { HistoryTool } from './types';
import type { DB } from '../db/client';

type Task = typeof schema.consumeTasks.$inferSelect;
export const createOnlineHistoryBuilder = (deps: {
  db: DB;
  archive: HistoryArchive;
  store: HistoryStore;
  generation: string;
  archiveIdentity: string;
  renderIdentity: string;
  renderParams?: RenderParams;
  limits?: Partial<HistoryLimits>;
  hydrateAltText?: (event: PipelineEvent, reserve: (bytes: number) => void) => void;
}) => {
  const { store, generation, db } = deps;
  const archive = createIndexedHistoryArchive(deps.archive, store.sqlite, generation);
  const limits = { ...defaultHistoryLimits, ...deps.limits };
  checkHistoryLimits(limits);
  const sourceBytes = Math.min(limits.maxSourceBytes, limits.maxWorkspaceBytes);
  const identity = store.db.select().from(schema.generations).where(eq(schema.generations.generation, generation)).get();
  if (identity && (identity.archiveIdentity !== deps.archiveIdentity || identity.renderIdentity !== deps.renderIdentity || identity.projectionVersion !== HISTORY_PROJECTION_VERSION)) throw new Error('History generation identity/version mismatch; create a new generation');
  const changes = createHistoryChanges(store.sqlite, generation);
  const observer = createSourceObserver({ db, archive, sqlite: store.sqlite, generation, maxSourceBytes: sourceBytes, maxStateEntries: limits.maxStateEntries });
  const consumer = () => store.db.select().from(schema.consumers).where(eq(schema.consumers.generation, generation)).get()!;
  const initializeChat = (chatId: string, capture = false) => store.initialize(generation, deps.archiveIdentity, deps.renderIdentity, chatId, () => capture
    ? archive.captureBounds(chatId) : { chatId, upperIds: { events: 0, turn_responses_v2: 0, compactions: 0 } });
  if (identity && !consumer()) throw new Error('Offline generation cannot become an online consumer; create a new generation');
  if (!consumer()) {
    // Capture locators only, in one short source snapshot. Membership includes
    // archive-only/nonresident chats and chats with only TRs or summaries.
    db.$client.transaction(() => store.db.transaction(tx => {
      const s0 = changes.watermark();
      tx.insert(schema.generations).values({ generation, archiveIdentity: deps.archiveIdentity, renderIdentity: deps.renderIdentity, projectionVersion: HISTORY_PROJECTION_VERSION }).onConflictDoNothing().run();
      let afterChat = '';
      for (;;) {
        const row = db.$client.prepare('SELECT min(chat_id) AS chatId FROM (SELECT min(chat_id) AS chat_id FROM events WHERE chat_id > ? UNION ALL SELECT min(chat_id) FROM turn_responses_v2 WHERE chat_id > ? UNION ALL SELECT min(chat_id) FROM compactions WHERE chat_id > ?)').get(afterChat, afterChat, afterChat) as { chatId: string | null };
        if (row.chatId === null) break;
        initializeChat(row.chatId, true);
        afterChat = row.chatId;
      }
      tx.insert(schema.consumers).values({ generation, baselineSeq: s0, consumeSeq: s0 }).run();
    }))();
  }
  const taskValue = (chatId: string, kind: Task['kind'], sourceKey: string) => ({ chatId, kind, sourceKey, taskKey: JSON.stringify([chatId, kind, sourceKey]) });
  const beginChange = (change: HistorySourceChange) => {
    if (Buffer.byteLength(JSON.stringify(change)) > limits.maxSourceBytes) throw new Error(`History log seq=${change.seq} exceeds source budget; cursor unchanged`);
    const tasks: ReturnType<typeof taskValue>[] = [];
    if (change.chatId !== null) initializeChat(change.chatId);
    if (change.sourceKind === 'image_alt_texts') tasks.push(taskValue('', 'cache', JSON.stringify([change.sourceKey, '', ''])));
    else if (change.sourceKind === 'events') {
      if ((change.targetIds?.length ?? 0) > limits.maxStateEntries) throw new Error(`History log seq=${change.seq} target count exceeds dependency budget; cursor unchanged`);
      for (const taskId of change.taskIds ?? []) tasks.push(taskValue(change.chatId!, 'completion', JSON.stringify([taskId, ''])));
      for (const id of change.targetIds ?? []) {
        tasks.push(taskValue(change.chatId!, 'message', id));
        tasks.push(taskValue(change.chatId!, 'replies', JSON.stringify([id, -Number.MAX_SAFE_INTEGER, 0])));
      }
      tasks.push(taskValue(change.chatId!, 'events', change.sourceKey));
    } else tasks.push(taskValue(change.chatId!, change.sourceKind, change.sourceKey));
    store.db.transaction(tx => {
      for (const task of tasks) tx.insert(schema.consumeTasks).values({ generation, ...task }).onConflictDoNothing().run();
      tx.update(schema.consumers).set({ pendingSeq: change.seq }).where(eq(schema.consumers.generation, generation)).run();
    });
  };
  let peakStateEntries = 0;
  let peakEncodedWorkspaceBytes = 0;
  const processTask = async (task: Task, seq: number): Promise<void> => {
    const budget = createWorkspaceBudget(limits);
    const bounds = archive.captureBounds(task.chatId);
    let plan: HistoryConsumeCommit = { generation, chatId: task.chatId, seq, taskKey: task.taskKey, changes: [], notices: [] };
    let nextKey: string | undefined;
    if (task.kind === 'cache') {
      const [cacheKey, afterChat, afterMessage] = JSON.parse(task.sourceKey) as [string, string, string];
      const target = store.db.select().from(schema.mediaDependencies).where(and(
        eq(schema.mediaDependencies.generation, generation), eq(schema.mediaDependencies.cacheKey, cacheKey),
        sql`(${schema.mediaDependencies.chatId}, ${schema.mediaDependencies.messageId}) > (${afterChat}, ${afterMessage})`,
      )).orderBy(schema.mediaDependencies.chatId, schema.mediaDependencies.messageId).limit(1).get();
      if (target) {
        nextKey = JSON.stringify([cacheKey, target.chatId, target.messageId]);
        plan = { ...plan, tasks: [taskValue(target.chatId, 'message', target.messageId), taskValue(target.chatId, 'replies', JSON.stringify([target.messageId, -Number.MAX_SAFE_INTEGER, 0]))] };
      }
    } else if (task.kind === 'replies') {
      const [messageId, time, id] = JSON.parse(task.sourceKey) as [string, number, number];
      const target = store.sqlite.prepare("SELECT message_id, time_ms AS received_at, source_id AS id FROM history_source_observations WHERE generation = ? AND source_kind = 'events' AND chat_id = ? AND reply_to_message_id = ? AND (time_ms, source_id) > (?, ?) ORDER BY time_ms, source_id LIMIT 1").get(generation, task.chatId, messageId, time, id) as { message_id: string; received_at: number; id: number } | undefined;
      if (target) {
        nextKey = JSON.stringify([messageId, target.received_at, target.id]);
        plan = { ...plan, tasks: [taskValue(task.chatId, 'message', target.message_id), taskValue(task.chatId, 'replies', JSON.stringify([target.message_id, -Number.MAX_SAFE_INTEGER, 0]))] };
      }
    } else if (task.kind === 'message') {
      const change = changes.next(seq - 1, sourceBytes);
      if (change?.seq !== seq) throw new Error('Missing historical source change');
      // Only parent-source fanout needs to reconstruct a reply-at-creation
      // snapshot. Own edits retain it; cache fills hydrate it directly.
      const refreshReplySnapshot = change.sourceKind === 'events' && !change.targetIds.includes(task.sourceKey);
      const state = restoreMessage({ ...deps, archive, refreshReplySnapshot, chatId: task.chatId, messageId: task.sourceKey, budget, maxSourceBytes: sourceBytes });
      if (state) {
        const ic = { ...createEmptyIC(task.chatId), nodes: [state.node] };
        const items = buildMessageItems(ic, new Map([[task.sourceKey, state.source]]), deps.renderParams);
        // The last source is used only as a revision locator, never reapplied.
        const event = archive.readEvents({ bounds, exactId: state.source.changedBy.id, limit: 1, maxBytes: sourceBytes }).rows[0]!;
        plan = { ...plan, event, messages: [{ node: state.node, source: state.source }], revisionRange: state.revisionRange, dependencies: [{ messageId: task.sourceKey, cacheKeys: state.cacheKeys }], changes: items.map(item => ({ operation: 'upsert', item })) };
      }
    } else if (task.kind === 'events') {
      const row = archive.readEvents({ bounds, exactId: Number(task.sourceKey), limit: 1, maxBytes: sourceBytes }).rows[0];
      if (!row) throw new Error('Missing archive event; cursor unchanged');
      // Runtime completion fanout uses explicit task IDs captured with the log.
      // Message changes are handled by their targeted canonical restore tasks.
    } else if (task.kind === 'completion') {
      const [taskId, afterTool] = JSON.parse(task.sourceKey) as [number, string];
      const target = store.db.select().from(schema.taskStarts).where(and(eq(schema.taskStarts.generation, generation), eq(schema.taskStarts.chatId, task.chatId), eq(schema.taskStarts.taskId, taskId), sql`${schema.taskStarts.toolKey} > ${afterTool}`)).orderBy(schema.taskStarts.toolKey).limit(1).get();
      const candidates = store.loadTask(generation, task.chatId, taskId, budget);
      const latest = store.sqlite.prepare("SELECT source_id AS id FROM history_source_observations WHERE generation = ? AND source_kind = 'events' AND chat_id = ? AND task_id = ? ORDER BY time_ms DESC, source_id DESC LIMIT 1").get(generation, task.chatId, taskId) as { id: number } | undefined;
      const row = latest ? archive.readEvents({ bounds, exactId: latest.id, limit: 1, maxBytes: sourceBytes }).rows[0] : undefined;
      if (row?.event.type === 'runtime') {
        budget.reserve(row.encodedBytes!);
        plan = { ...plan, event: row, notices: candidates.count === 1 ? [] : [{ kind: candidates.count > 1 ? 'ambiguous-task-completion' : 'unlinked-task-completion', source: row.ref, taskId }] };
      }
      if (target) {
        const tool = store.loadTool(generation, task.chatId, target.toolKey, budget);
        const item = {
          ...tool, completion: candidates.count === 1 && row?.event.type === 'runtime' ? {
            source: row.ref, sourceRevision: row.revision, taskId, taskType: row.event.taskType, finalSummary: row.event.finalSummary, hasFullOutput: row.event.hasFullOutput,
          } : undefined,
        };
        plan = { ...plan, changes: [{ operation: 'upsert', item }] };
        nextKey = JSON.stringify([taskId, target.toolKey]);
      }
    } else if (task.kind === 'turn_responses_v2') {
      const row = (await archive.readTurns({ bounds, exactId: Number(task.sourceKey), limit: 1, maxBytes: sourceBytes })).rows[0];
      if (!row) throw new Error('Missing archive turn; cursor unchanged');
      if (row) {
        budget.reserve(row.encodedBytes!);
        const items = buildTurnItems(row, limits.maxOutputItems);
        const taskIds = new Set<number>();
        const previous = store.db.select({ taskId: schema.taskStarts.taskId }).from(schema.taskStarts).where(and(eq(schema.taskStarts.generation, generation), eq(schema.taskStarts.chatId, task.chatId), sql`${schema.taskStarts.toolKey} IN (SELECT item_key FROM history_items WHERE generation = ${generation} AND chat_id = ${task.chatId} AND source_order = 1 AND source_id = ${Number(task.sourceKey)})`)).limit(limits.maxStateEntries + 1).all();
        if (previous.length > limits.maxStateEntries) throw new Error('Historical task dependency budget exceeded; cursor unchanged');
        for (const old of previous) taskIds.add(old.taskId);
        const tools = new Map(items.filter((item): item is HistoryTool => item.kind === 'tool-execution').map(item => [item.key, item]));
        for (const item of items) {
          if (item.kind !== 'tool-result' || !item.toolKey) continue;
          const tool = tools.get(item.toolKey);
          if (!tool) continue;
          const id = startedTaskId(tool, item);
          if (id !== undefined) taskIds.add(id);
        }
        const runtimeTasks = [...taskIds].map(id => taskValue(task.chatId, 'completion', JSON.stringify([id, ''])));
        plan = { ...plan, replaceTurnId: Number(task.sourceKey), tasks: runtimeTasks, changes: items.map(item => ({ operation: 'upsert', item })) };
      }
    } else {
      const row = archive.readCompactions({ bounds, exactId: Number(task.sourceKey), limit: 1, maxBytes: sourceBytes }).rows[0];
      if (!row) throw new Error('Missing archive summary; cursor unchanged');
      if (row) plan = { ...plan, changes: [{ operation: 'upsert', item: summaryItem(row) }] };
    }
    if (plan.changes.length > limits.maxOutputItems) throw new Error('History output item budget exceeded; cursor unchanged');
    budget.reserve(Buffer.byteLength(JSON.stringify(plan)));
    peakStateEntries = Math.max(peakStateEntries, budget.entries);
    peakEncodedWorkspaceBytes = Math.max(peakEncodedWorkspaceBytes, budget.encodedBytes);
    store.commitConsume({ ...plan, nextKey });
  };
  const status = () => {
    const state = consumer();
    const watermark = changes.watermark();
    const memory = process.memoryUsage();
    return {
      ...state, phase: observer.status().completedSourcePolls === 0 ? 'source-scan' : store.db.select().from(schema.checkpoints).where(and(eq(schema.checkpoints.generation, generation), eq(schema.checkpoints.scanComplete, false))).limit(1).get() ? 'bootstrap' : state.baselineComplete ? 'live' : 'reconciling', peakStateEntries, peakEncodedWorkspaceBytes, observedSeq: watermark, logLag: changes.lag(state.consumeSeq), ...observer.status(),
      coverage: store.db.select().from(schema.checkpoints).where(eq(schema.checkpoints.generation, generation)).limit(256).all(),
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external, arrayBufferBytes: memory.arrayBuffers,
    };
  };
  return {
    status,
    async step(signal?: AbortSignal): Promise<{ processedRows: number }> {
      if (signal?.aborted) return { processedRows: 0 };
      if (observer.status().completedSourcePolls === 0) return await observer.step();
      const incomplete = store.db.select().from(schema.checkpoints).where(and(eq(schema.checkpoints.generation, generation), eq(schema.checkpoints.scanComplete, false))).orderBy(asc(schema.checkpoints.chatId)).limit(1).get();
      if (incomplete) {
        const result = await buildHistorySlice({ ...deps, archive, chatId: incomplete.chatId, signal, compactionsById: true, limits: { ...limits, maxRowsPerSlice: 1 } });
        peakStateEntries = Math.max(peakStateEntries, result.peakStateEntries);
        peakEncodedWorkspaceBytes = Math.max(peakEncodedWorkspaceBytes, result.peakEncodedWorkspaceBytes);
        return result;
      }
      let state = consumer();
      // Pause append discovery at a bounded backlog. Unobserved rows remain in
      // the core archive; durable media receipt/recovery can still progress.
      const observed = await observer.step(changes.lag(state.consumeSeq) < 256);
      const scan = observer.status();
      if (state.reconcileSeq === null && scan.completedSourcePolls > 1) {
        store.db.update(schema.consumers).set({ reconcileSeq: changes.watermark() }).where(eq(schema.consumers.generation, generation)).run();
        state = consumer();
      }
      if (!state.baselineComplete && state.reconcileSeq !== null && state.consumeSeq >= state.reconcileSeq) store.db.transaction(tx => {
        tx.update(schema.consumers).set({ baselineComplete: true }).where(eq(schema.consumers.generation, generation)).run();
        store.sqlite.prepare('DELETE FROM history_pending_media WHERE generation = ? AND scheduled_seq <= ?').run(generation, state.consumeSeq);
      });
      if (state.pendingSeq === null) {
        const next = changes.next(state.consumeSeq, sourceBytes);
        if (!next) return observed;
        beginChange(next);
        state = consumer();
      }
      const task = store.db.select().from(schema.consumeTasks).where(and(eq(schema.consumeTasks.generation, generation), eq(schema.consumeTasks.done, false))).orderBy(schema.consumeTasks.taskKey).limit(1).get();
      if (!task) throw new Error(`Missing consume task seq=${state.pendingSeq}`);
      try { await processTask(task, state.pendingSeq!); } catch (cause) {
        throw new Error(`History consume failed: generation=${generation} seq=${state.pendingSeq} chat=${task.chatId} kind=${task.kind} key=${task.sourceKey}`, { cause });
      }
      return { processedRows: 1 };
    },
  };
};
