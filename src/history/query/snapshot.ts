import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';

import type { HistorySource } from '../../db/history-archive';
import { searchableText } from '../store';
import type { HistoryItem, HistoryMessage } from '../types';
import type { HistoryWorkerOptions } from '../worker';
import { fail } from './budget';
import { itemRef, keyRef, publicKind } from './refs';

export interface QueryScope {
  historyPath: string;
  archivePath: string;
  generation: string;
  chatId: string;
  blockedUserIds: readonly string[];
  includeDeleted?: boolean;
  renderParams?: HistoryWorkerOptions['renderParams'];
}
const sources: readonly HistorySource[] = ['events', 'turn_responses_v2', 'compactions'];
const validJson = (value: string): string | null => { try { JSON.parse(value); return value; } catch { return null; } };
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const stepRef = (id: number) => `execution:${id}`;

export const openQuerySnapshot = (scope: QueryScope) => {
  let sqlite: SqliteDatabase;
  try { sqlite = new Database(scope.historyPath, { readonly: true, fileMustExist: true }); } catch { return fail('index_not_ready', 'History index is not readable'); }
  try {
    sqlite.pragma('busy_timeout = 100');
    sqlite.pragma('cache_size = -2048');
    sqlite.pragma('temp_store = FILE');
    // BEGIN is pinned by the first read, before status, views or SDK calls.
    sqlite.exec('BEGIN');
    if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='history_executions' AND type='table'").get()) fail('index_not_ready', 'History query migration has not completed');
    const coverage = sqlite.prepare('SELECT source_kind AS source, upper_id AS upperId, after_json AS after, scan_complete AS complete FROM history_checkpoints WHERE generation=? AND chat_id=? ORDER BY source_kind').all(scope.generation, scope.chatId) as { source: HistorySource; upperId: number; after: string | null; complete: number }[];
    const state = sqlite.prepare('SELECT baseline_complete AS baselineComplete, consume_seq AS consumeSeq, reconcile_seq AS reconcileSeq FROM history_consumers WHERE generation=?').get(scope.generation) as { baselineComplete: number; consumeSeq: number; reconcileSeq: number | null } | undefined;
    const scan = sqlite.prepare('SELECT state_json AS value FROM history_source_scans WHERE generation=?').get(scope.generation) as { value: string } | undefined;
    const scanned = scan ? JSON.parse(scan.value) as { completedPolls: number; completedAtMs: number | null } : undefined;
    const observed = Object.fromEntries(sources.map(source => [source, (sqlite.prepare('SELECT coalesce(max(source_id),0) AS id FROM history_source_observations WHERE generation=? AND chat_id=? AND source_kind=?').get(scope.generation, scope.chatId, source) as { id: number }).id]));
    const lag = state ? (sqlite.prepare(`SELECT count(*) AS n FROM history_source_changes c WHERE generation=? AND seq>? AND
      (json_extract(change_json,'$.chatId')=? OR (json_extract(change_json,'$.chatId') IS NULL AND json_extract(change_json,'$.sourceKind')='image_alt_texts' AND EXISTS
      (SELECT 1 FROM history_media_dependencies d WHERE d.generation=c.generation AND d.chat_id=? AND d.cache_key=json_extract(c.change_json,'$.sourceKey'))))`).get(scope.generation, state.consumeSeq, scope.chatId, scope.chatId) as { n: number }).n : null;
    const complete = coverage.length === 3 && coverage.every(row => row.complete === 1);
    const baselineComplete = complete && (state ? state.baselineComplete === 1 : false);
    const index = {
      phase: coverage.length === 0 ? 'not_indexed' : !complete ? 'building' : baselineComplete ? 'live' : state ? 'reconciling' : 'offline',
      baselineComplete,
      coverage: coverage.map(row => ({ ...row, after: row.after ? JSON.parse(row.after) as unknown : null, complete: row.complete === 1 })),
      // Local sequence is a materialization prefix, never a chat time boundary.
      indexedThrough: { observationPrefix: state?.consumeSeq ?? null },
      observed: { sourceIds: observed, lastCompletedPollAtMs: scanned?.completedAtMs ?? null },
      lag: { observedChanges: lag, freshness: 'last_observed' },
    };
    const blocked = new Set(scope.blockedUserIds);
    // One-row decode cache avoids reparsing a large payload for every hidden
    // dependency. It never retains the chat or exposes a host handle.
    let cachedJson: string | undefined;
    let cachedItem: HistoryItem | undefined;
    const decode = (encoded: string): HistoryItem => {
      if (cachedJson !== encoded) { cachedJson = encoded; cachedItem = JSON.parse(encoded) as HistoryItem; }
      return cachedItem!;
    };
    const hiddenMessage = (message: HistoryMessage): boolean => (!scope.includeDeleted && message.metadata.deleted) || (message.metadata.sender !== undefined && blocked.has(message.metadata.sender.id));
    let inspectedItem: HistoryItem | undefined;
    let inspectedContent: { strings: string[]; blockedIdentity: boolean } | undefined;
    const content = (item: HistoryItem): { strings: string[]; blockedIdentity: boolean } => {
      if (inspectedItem === item) return inspectedContent!;
      const strings: string[] = []; let blockedIdentity = false;
      const pending: { value: unknown; key: string; parent: string }[] = [{ value: item, key: '', parent: '' }];
      while (pending.length) {
        const { value, key, parent } = pending.pop()!;
        if (typeof value === 'string' || typeof value === 'number') {
          const text = String(value); strings.push(text);
          if ((/^(sender_id|senderId|user_id|userId|uid)$/.test(key) || (key === 'id' && /sender|user/i.test(parent))) && blocked.has(text)) blockedIdentity = true;
          if (typeof value === 'string' && (value.trimStart().startsWith('{') || value.trimStart().startsWith('['))) {
            let decoded: unknown;
            try { decoded = JSON.parse(value) as unknown; } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
              continue; // Plain text is not JSON.
            }
            pending.push({ value: decoded, key: '', parent: '' });
          }
        } else if (Array.isArray(value)) {
          for (const child of value) pending.push({ value: child, key, parent });
        } else if (value && typeof value === 'object') {
          for (const [childKey, child] of Object.entries(value)) pending.push({ value: child, key: childKey, parent: key });
        }
      }
      inspectedItem = item;
      inspectedContent = { strings, blockedIdentity };
      return inspectedContent;
    };
    const directSensitive = (item: HistoryItem): boolean => {
      if (item.kind === 'message' && hiddenMessage(item)) return true;
      if (blocked.size === 0) return false;
      const value = content(item);
      return value.blockedIdentity || value.strings.some(text => [...blocked].some(id => text.includes(`uid="${id}"`) || text.includes(`user_id="${id}"`)));
    };
    const containsHidden = (item: HistoryItem, target: HistoryMessage): boolean => {
      const strings = content(item).strings;
      const text = target.transcript.text;
      return strings.some(value => (text.length > 0 && value.includes(text)) || value.includes(`message:${target.metadata.messageId}`))
        || (item.kind === 'message' && item.metadata.replyTo?.messageId === target.metadata.messageId);
    };
    // SQLite callbacks remain pure: better-sqlite3 disallows reentering the
    // connection inside a callback. SQL evaluates hidden dependencies itself.
    sqlite.function('__history_direct', { deterministic: true }, (encoded: string) => directSensitive(decode(encoded)) ? 1 : 0);
    sqlite.function('__history_contains', { deterministic: true }, (encoded: string, hidden: string) => containsHidden(decode(encoded), JSON.parse(hidden) as HistoryMessage) ? 1 : 0);
    const visible = (item: HistoryItem): boolean => {
      if (directSensitive(item)) return false;
      if (sqlite.prepare('SELECT 1 FROM temp.__history_hidden WHERE __history_contains(?,item_json)=1 LIMIT 1').get(JSON.stringify(item))) return false;
      if (item.order.sourceOrder === 1) return !sqlite.prepare('SELECT 1 FROM main.history_items i WHERE generation=? AND chat_id=? AND source_order=1 AND source_id=? AND id NOT IN (SELECT id FROM temp.__history_base) LIMIT 1').get(scope.generation, scope.chatId, item.source.id);
      return true;
    };
    const publicItem = (item: HistoryItem) => {
      const common = {
        ref: itemRef(item), kind: publicKind(item.kind), timeMs: item.order.timeMs,
        source: { refs: [`${item.source.source === 'events' ? 'event' : item.source.source === 'compactions' ? 'summary' : 'execution'}:${item.source.id}`], revision: item.sourceRevision },
      };
      switch (item.kind) {
      case 'message': return { ...common, messageId: item.metadata.messageId, metadata: item.metadata, text: item.transcript.text, renderedText: item.transcript.xml, replyText: item.transcript.reply?.text ?? null, omitted: { images: item.metadata.attachments.length > 0, reasoning: false } };
      case 'model-output': return { ...common, stepRef: stepRef(item.source.id), entryIndex: item.entryIndex, modelName: item.modelName, body: item.parts, text: searchableText(item), omitted: item.omitted ?? null };
      case 'tool-execution': return { ...common, stepRef: stepRef(item.source.id), outputRef: keyRef(item.outputKey, 'model-output'), partIndex: item.position.partIndex, callId: item.callId, toolName: item.name, args: item.args, argsJson: validJson(item.args), resultRefs: item.resultKeys.map(key => keyRef(key, 'tool-result')), completion: item.completion ? { taskId: item.completion.taskId, taskType: item.completion.taskType, finalSummary: item.completion.finalSummary, hasFullOutput: item.completion.hasFullOutput, sourceRef: `event:${item.completion.source.id}` } : null, pairing: item.pairing };
      case 'tool-result': return { ...common, stepRef: stepRef(item.source.id), entryIndex: item.entryIndex, callId: item.callId, callRef: item.toolKey ? keyRef(item.toolKey, 'tool-execution') : null, outputRef: item.outputKey ? keyRef(item.outputKey, 'model-output') : null, payload: item.payload, resultJson: typeof item.payload === 'string' ? validJson(item.payload) : null, text: searchableText(item), requiresFollowUp: item.requiresFollowUp, pairing: item.pairing, omitted: { images: typeof item.payload !== 'string' && item.payload.some(part => part.kind === 'image'), reasoning: false } };
      case 'summary': return { ...common, text: item.summary, summary: item.summary, createdAtMs: item.createdAtMs, oldCursorMs: item.coverage.fromReceivedAtMs, newCursorMs: item.coverage.untilReceivedAtMs, previousSummaryRef: null, sourceRefs: [], usage: item.usage ?? null, omitted: { images: false, reasoning: false } };
      }
    };
    sqlite.function('__history_public', { deterministic: true }, (encoded: string) => JSON.stringify(publicItem(decode(encoded))));
    sqlite.function('__history_ref', { deterministic: true }, (key: string, kind: HistoryItem['kind']) => keyRef(key, kind));
    const gen = quote(scope.generation); const chat = quote(scope.chatId);
    sqlite.exec(`
      CREATE TEMP TABLE __history_hidden(id INTEGER PRIMARY KEY,item_json TEXT NOT NULL);
      INSERT INTO temp.__history_hidden SELECT id,item_json FROM main.history_items WHERE generation=${gen} AND chat_id=${chat} AND kind='message' AND ((json_extract(item_json,'$.metadata.deleted')=1 AND ${scope.includeDeleted ? 0 : 1}) OR json_extract(item_json,'$.metadata.sender.id') IN (SELECT value FROM json_each(${quote(JSON.stringify([...blocked]))})));
      CREATE TEMP TABLE __history_allowed(id INTEGER PRIMARY KEY);
      INSERT INTO temp.__history_allowed SELECT id FROM main.history_items i WHERE generation=${gen} AND chat_id=${chat} AND __history_direct(item_json)=0 AND NOT EXISTS (SELECT 1 FROM temp.__history_hidden h WHERE __history_contains(i.item_json,h.item_json)=1);
      DELETE FROM temp.__history_allowed WHERE id IN (SELECT i.id FROM main.history_items i WHERE i.generation=${gen} AND i.chat_id=${chat} AND i.source_order=1 AND i.source_id IN (SELECT member.source_id FROM main.history_items member LEFT JOIN temp.__history_allowed a ON a.id=member.id WHERE member.generation=${gen} AND member.chat_id=${chat} AND member.source_order=1 AND a.id IS NULL));
      CREATE TEMP VIEW __history_base AS SELECT i.* FROM main.history_items i JOIN temp.__history_allowed a ON a.id=i.id;
      -- Materialize only authorized JSON-safe public fields into SQLite's
      -- file-backed TEMP store. Repeated joins must not re-run policy/decoding
      -- quadratically; no unmasked chat array is loaded into Node memory.
      CREATE TEMP TABLE __history_scope AS SELECT id,item_key,kind,time_ms,source_order,source_id,entry_index,part_index,search_text,
        __history_ref(item_key,kind) AS ref, __history_public(item_json) AS data
        FROM temp.__history_base;
      CREATE UNIQUE INDEX __history_scope_id ON __history_scope(id);
      CREATE UNIQUE INDEX __history_scope_ref ON __history_scope(ref);
      CREATE INDEX __history_scope_kind ON __history_scope(kind,time_ms,source_order,source_id,entry_index,part_index);
      CREATE INDEX __history_scope_output ON __history_scope(json_extract(data,'$.outputRef'));
      CREATE INDEX __history_scope_call ON __history_scope(json_extract(data,'$.callRef'));
      CREATE TEMP VIEW records AS SELECT id,ref,json_extract(data,'$.kind') AS kind,time_ms,source_order,source_id,entry_index,part_index,search_text AS text,
        json_extract(data,'$.metadata.sender.id') AS sender_id, json_extract(data,'$.messageId') AS message_id,
        coalesce(json_extract(data,'$.toolName'),(SELECT json_extract(c.data,'$.toolName') FROM temp.__history_scope c WHERE c.ref=json_extract(s.data,'$.callRef'))) AS tool_name,
        json_extract(data,'$.outputRef') AS parent_ref,json_extract(data,'$.callRef') AS call_ref
        FROM temp.__history_scope s;
      CREATE TEMP VIEW records_fts AS SELECT f.rowid, f.search_text AS text, f.rank, f.history_fts AS records_fts
        FROM main.history_fts f JOIN temp.records r ON r.id=f.rowid;
      CREATE TEMP VIEW messages AS SELECT ref,${chat} AS chat_id,json_extract(data,'$.messageId') AS message_id,source_id AS source_event_id,time_ms,
        json_extract(data,'$.metadata.timestampSec') AS timestamp_sec,json_extract(data,'$.metadata.editedAtSec') AS edited_at,
        json_extract(data,'$.metadata.sender.id') AS sender_id,json_extract(data,'$.metadata.sender') AS sender_json,
        json_extract(data,'$.metadata.replyTo') AS reply_json,
        CASE WHEN json_extract(data,'$.metadata.replyTo.messageId') IS NOT NULL THEN 'message:'||json_extract(data,'$.metadata.replyTo.messageId') END AS reply_to_ref,
        json_extract(data,'$.metadata.forwardInfo') AS forward_json,json_extract(data,'$.metadata.deleted') AS deleted,json_extract(data,'$.metadata.isSelfSent') AS is_self_sent,
        data AS body_json,json_extract(data,'$.renderedText') AS rendered_text,json_extract(data,'$.text') AS text,json_extract(data,'$.source.refs') AS source_refs_json
        FROM temp.__history_scope WHERE kind='message';
      CREATE TEMP VIEW outputs AS SELECT ref,${chat} AS chat_id,json_extract(data,'$.stepRef') AS step_ref,entry_index,time_ms,json_extract(data,'$.modelName') AS model_name,json_extract(data,'$.body') AS body_json,json_extract(data,'$.text') AS text,json_extract(data,'$.omitted') AS omitted_json FROM temp.__history_scope WHERE kind='model-output';
      CREATE TEMP VIEW executions AS SELECT 'execution:'||e.source_id AS step_ref,${chat} AS chat_id,e.time_ms,e.model_name,e.usage_json FROM main.history_executions e WHERE e.generation=${gen} AND e.chat_id=${chat} AND NOT EXISTS (SELECT 1 FROM main.history_items i WHERE i.generation=e.generation AND i.chat_id=e.chat_id AND i.source_order=1 AND i.source_id=e.source_id AND i.id NOT IN (SELECT id FROM temp.__history_base));
      CREATE TEMP VIEW tool_calls AS SELECT ref,${chat} AS chat_id,json_extract(data,'$.outputRef') AS output_ref,json_extract(data,'$.stepRef') AS step_ref,part_index,json_extract(data,'$.callId') AS call_id,json_extract(data,'$.toolName') AS tool_name,json_extract(data,'$.argsJson') AS args_json,json_extract(data,'$.args') AS args_text,json_extract(data,'$.resultRefs[0]') AS result_ref,json_extract(data,'$.resultRefs') AS result_refs_json,json_extract(data,'$.completion') AS completion_json,time_ms FROM temp.__history_scope WHERE kind='tool-execution';
      CREATE TEMP VIEW tool_results AS SELECT ref,${chat} AS chat_id,json_extract(data,'$.callRef') AS call_ref,json_extract(data,'$.outputRef') AS output_ref,json_extract(data,'$.stepRef') AS step_ref,entry_index,json_extract(data,'$.callId') AS call_id,(SELECT json_extract(c.data,'$.toolName') FROM temp.__history_scope c WHERE c.ref=json_extract(s.data,'$.callRef')) AS tool_name,
        json_quote(json_extract(data,'$.payload')) AS payload_json,json_extract(data,'$.resultJson') AS result_json,json_extract(data,'$.text') AS text,json_extract(data,'$.requiresFollowUp') AS requires_follow_up,time_ms FROM temp.__history_scope s WHERE kind='tool-result';
      CREATE TEMP VIEW summaries AS SELECT ref,${chat} AS chat_id,json_extract(data,'$.summary') AS summary,json_extract(data,'$.oldCursorMs') AS old_cursor_ms,json_extract(data,'$.newCursorMs') AS new_cursor_ms,time_ms AS created_at,NULL AS previous_summary_ref,json_extract(data,'$.sourceRefs') AS source_refs_json,json_extract(data,'$.usage') AS usage_json FROM temp.__history_scope WHERE kind='summary';
      CREATE TEMP VIEW links AS SELECT f.ref AS from_ref,t.ref AS to_ref,CASE l.kind WHEN 'reply' THEN 'reply_to' WHEN 'sent-message' THEN 'sent_message' ELSE l.kind END AS kind FROM main.history_relations l JOIN temp.__history_scope f ON f.item_key=l.from_key JOIN temp.__history_scope t ON t.item_key=l.to_key WHERE l.generation=${gen} AND l.chat_id=${chat};
      CREATE TEMP VIEW __history_units AS SELECT ref,CASE
        WHEN kind IN ('tool_call','tool_result') THEN coalesce(parent_ref,ref)
        WHEN kind='message' THEN coalesce((SELECT c.output_ref FROM temp.messages m JOIN temp.links l ON l.to_ref=m.ref AND l.kind='sent_message' JOIN temp.tool_calls c ON c.ref=l.from_ref WHERE m.ref=records.ref AND m.is_self_sent=1 ORDER BY c.time_ms,c.ref LIMIT 1),ref)
        ELSE ref END AS unit_ref FROM temp.records;
    `);
    sqlite.pragma('query_only = ON');
    return { sqlite: sqlite as SqliteDatabase, scope, nonce: randomUUID(), index, visible, publicItem, close: () => { if (sqlite.inTransaction) sqlite.exec('ROLLBACK'); sqlite.close(); } };
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK'); sqlite.close();
    throw error;
  }
};
export type QuerySnapshot = ReturnType<typeof openQuerySnapshot>;
