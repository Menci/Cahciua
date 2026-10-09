import type { ArchivedEvent, ArchiveKey, HistoryArchive, HistoryArchiveBounds } from '../db/history-archive';
import { createEmptyIC, reduce } from '../projection';
import type { PipelineEvent } from '../projection';
import type { RenderParams } from '../rendering';
import { buildMessageItems, updateMessageSource } from './message-items';
import type { MessageSource } from './message-items';
import { startedTaskId } from './task-items';
import { buildTurnItems, historyKey } from './turn-items';
import type { HistoryBatch, HistoryChange, HistoryNotice, HistoryTool } from './types';

// One build owns one chat's IC/cache. Consume with `for await` and atomically
// upsert each batch with its progress. Restart by replaying from the origin:
// saving page cursors alone cannot restore Projection dependencies.
export const buildHistoryInput = async function* (deps: {
  archive: HistoryArchive;
  bounds: HistoryArchiveBounds;
  pageSize: number;
  renderParams?: RenderParams;
  hydrateAltText?: (event: PipelineEvent) => void;
}): AsyncGenerator<HistoryBatch> {
  const { archive, bounds, pageSize } = deps;
  const chatId = bounds.chatId;
  let ic = createEmptyIC(chatId);
  const messageSources = new Map<string, MessageSource>();
  const tasks = new Map<number, HistoryTool[]>();
  let after: ArchiveKey | undefined;

  // TR first permits exact completion updates during event replay. Emission
  // order is deliberately independent of the durable timeline order on items.
  for (;;) {
    const page = await archive.readTurns({ bounds, after, limit: pageSize });
    const changes: HistoryChange[] = [];
    for (const turn of page.rows) {
      const items = buildTurnItems(turn);
      const tools = new Map(items.filter((item): item is HistoryTool => item.kind === 'tool-execution').map(tool => [tool.key, tool]));
      for (const result of items) {
        if (result.kind !== 'tool-result' || !result.toolKey) continue;
        const tool = tools.get(result.toolKey)!;
        const taskId = startedTaskId(tool, result);
        if (taskId !== undefined) tasks.set(taskId, [...(tasks.get(taskId) ?? []), tool]);
      }
      changes.push(...items.map(item => ({ operation: 'upsert' as const, item })));
    }
    yield { changes, notices: [], progress: { bounds, source: 'turn_responses_v2', after: page.next ?? after, done: page.done } };
    if (page.done) break;
    after = page.next;
  }

  const applySource = (messageId: string, row: ArchivedEvent): void => {
    const source = updateMessageSource(messageSources.get(messageId), row);
    if (source) messageSources.set(messageId, source);
  };
  after = undefined;
  for (;;) {
    const page = archive.readEvents({ bounds, after, limit: pageSize });
    const touched = new Set<string>();
    const changes: HistoryChange[] = [];
    const notices: HistoryNotice[] = [];
    for (const row of page.rows) {
      const event = row.event;
      deps.hydrateAltText?.(event);
      ic = reduce(ic, event);
      if (event.type === 'message' || event.type === 'edit') {
        touched.add(event.messageId);
        applySource(event.messageId, row);
      } else if (event.type === 'delete') {
        for (const messageId of event.messageIds) {
          touched.add(messageId);
          applySource(messageId, row);
        }
      } else if (event.type === 'runtime') {
        const candidates = tasks.get(event.taskId) ?? [];
        if (candidates.length !== 1) {
          notices.push({ kind: candidates.length > 1 ? 'ambiguous-task-completion' : 'unlinked-task-completion', source: row.ref, taskId: event.taskId });
        } else {
          const tool = candidates[0]!;
          changes.push({
            operation: 'upsert', item: {
              ...tool, completion: {
                source: row.ref, sourceRevision: row.revision, taskId: event.taskId, taskType: event.taskType,
                finalSummary: event.finalSummary, hasFullOutput: event.hasFullOutput,
              },
            },
          });
        }
      }
    }
    // System/runtime nodes cannot be dependencies of message/reply reducers.
    // Keep users/chat state and every message, including deleted targets.
    ic = { ...ic, nodes: ic.nodes.filter(node => node.type === 'message') };
    const nodes = ic.nodes.filter(node => node.type === 'message' && touched.has(node.messageId));
    changes.push(...buildMessageItems({ ...ic, nodes }, messageSources, deps.renderParams).map(item => ({ operation: 'upsert' as const, item })));
    yield { changes, notices, progress: { bounds, source: 'events', after: page.next ?? after, done: page.done } };
    if (page.done) break;
    after = page.next;
  }

  after = undefined;
  for (;;) {
    const page = archive.readCompactions({ bounds, after, limit: pageSize });
    const changes: HistoryChange[] = page.rows.map(row => ({
      operation: 'upsert', item: {
        kind: 'summary', key: historyKey(chatId, 'summary', row.ref.id), chatId,
        source: row.ref, sourceRevision: row.revision,
        order: { timeMs: row.createdAtMs, sourceOrder: 2, sourceId: row.ref.id, entryIndex: -1, partIndex: -1 },
        summary: row.summary, compactionId: row.ref.id, createdAtMs: row.createdAtMs,
        coverage: { fromReceivedAtMs: row.oldCursorMs, untilReceivedAtMs: row.newCursorMs },
      },
    }));
    yield { changes, notices: [], progress: { bounds, source: 'compactions', after: page.next ?? after, done: page.done } };
    if (page.done) break;
    after = page.next;
  }
};
