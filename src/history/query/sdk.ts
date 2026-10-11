import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { createHistoryArchive, HistorySourceBudgetError } from '../../db/history-archive';
import * as archiveSchema from '../../db/schema';
import { createEmptyIC, reduce } from '../../projection';
import { buildMessageItems, updateMessageSource } from '../message-items';
import { searchableText } from '../store';
import type { HistoryItem } from '../types';
import { checkBytes, createQueryBudget, fail, QueryError } from './budget';
import type { QueryLimits } from './budget';
import type { QuerySnapshot } from './snapshot';
import { authorizeSql } from './sql-guard';

export type SqlValue = string | number | null;
export type RecordKind = 'message' | 'assistant_text' | 'tool_call' | 'tool_result' | 'summary';
export interface Filter {
  kinds?: RecordKind[];
  senderId?: string;
  toolName?: string;
  afterMs?: number;
  beforeMs?: number;
}
export interface PageOptions { limit?: number; cursor?: string }
export interface ContextOptions extends PageOptions { before?: number; after?: number; offset?: number; maxChars?: number }
const order = 'time_ms,source_order,source_id,entry_index,part_index';
interface RecordRow { id: number; ref: string; kind: RecordKind; time_ms: number; source_order: number; source_id: number; entry_index: number; part_index: number; text: string; sender_id: string | null; message_id: string | null; tool_name: string | null; parent_ref: string | null; call_ref: string | null }
const integer = (value: number | undefined, fallback: number, maximum: number, label: string, minimum = 1): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) fail('invalid_options', `${label} must be between ${minimum} and ${maximum}`);
  return resolved;
};
const filterWhere = (filter: Filter): { where: string; params: SqlValue[] } => {
  const clauses: string[] = []; const params: SqlValue[] = [];
  if (filter.kinds) {
    if (!Array.isArray(filter.kinds) || filter.kinds.some(kind => !['message', 'assistant_text', 'tool_call', 'tool_result', 'summary'].includes(kind))) fail('invalid_options', 'Unknown record kind');
    clauses.push('kind IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(filter.kinds));
  }
  for (const [field, value] of [['sender_id', filter.senderId], ['tool_name', filter.toolName]] as const)
    if (value !== undefined) { if (typeof value !== 'string') fail('invalid_options', `${field} must be a string`); clauses.push(`${field}=?`); params.push(value); }
  for (const [operator, value] of [['>=', filter.afterMs], ['<', filter.beforeMs]] as const)
    if (value !== undefined) { if (!Number.isSafeInteger(value)) fail('invalid_options', 'Time boundary must be a safe integer'); clauses.push(`time_ms${operator}?`); params.push(value); }
  return { where: clauses.length ? clauses.join(' AND ') : '1', params };
};

const filterSignature = (options: Filter, limit: number) => ({ limit, kinds: options.kinds ? [...options.kinds].sort() : null, senderId: options.senderId ?? null, toolName: options.toolName ?? null, afterMs: options.afterMs ?? null, beforeMs: options.beforeMs ?? null });

const preview = (value: unknown): Record<string, unknown> => {
  const truncated: { path: string; totalLength: number }[] = [];
  const visit = (input: unknown, path: string): unknown => {
    if (typeof input === 'string') {
      let length = 0; let prefix = '';
      for (const point of input) { if (length < 1200) prefix += point; length++; }
      if (length <= 1200) return input;
      truncated.push({ path, totalLength: length });
      return prefix;
    }
    if (Array.isArray(input)) return input.map((child, i) => visit(child, `${path}[${i}]`));
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, visit(child, `${path}.${key}`)]));
    return input;
  };
  return { ...visit(value, '$') as Record<string, unknown>, previewTruncated: truncated };
};

export const createQuerySdk = (snapshot: QuerySnapshot, limits: QueryLimits) => {
  const { sqlite, scope } = snapshot;
  const budget = createQueryBudget(limits);
  const cursors = new Map<string, { signature: string; offset: number }>();
  let nextCursor = 0;
  const signature = (operation: string, options: unknown) => JSON.stringify([operation, options]);
  const pageStart = (cursor: string | undefined, sig: string): number => {
    if (!cursor) return 0;
    const saved = cursors.get(cursor);
    if (saved?.signature !== sig) return fail('invalid_cursor', 'Cursor belongs to another snapshot, operation or filter');
    return saved.offset;
  };
  const cursorFor = (sig: string, offset: number): string => {
    const cursor = `${snapshot.nonce}/${++nextCursor}`; cursors.set(cursor, { signature: sig, offset }); return cursor;
  };
  const readItem = (ref: string, requireVisible = true): HistoryItem | undefined => {
    const row = sqlite.prepare('SELECT item_json AS value FROM main.history_items WHERE generation=? AND chat_id=? AND __history_ref(item_key,kind)=?').get(scope.generation, scope.chatId, ref) as { value: string } | undefined;
    const item = row ? JSON.parse(row.value) as HistoryItem : undefined;
    return item && (!requireVisible || snapshot.visible(item)) ? item : undefined;
  };
  const publicValue = (item: HistoryItem) => snapshot.publicItem(item);
  const grouped = (item: HistoryItem): unknown => {
    const output = item.kind === 'model-output' ? item : item.kind === 'tool-execution' ? readItem(`output:${item.source.id}/entry:${item.position.entryIndex}`) : item.kind === 'tool-result' && item.outputKey ? readItem(`output:${item.source.id}/entry:${JSON.parse(item.outputKey)[3] as number}`) : undefined;
    if (output?.kind !== 'model-output') return preview(publicValue(item));
    const tools = output.toolKeys.flatMap(key => {
      const parts = JSON.parse(key) as (string | number)[];
      const call = readItem(`call:${parts[2]}/entry:${parts[3]}/part:${parts[4]}`);
      if (call?.kind !== 'tool-execution') return [];
      return [{
        ...publicValue(call), sentMessages: (sqlite.prepare("SELECT m.ref,m.message_id,m.time_ms FROM temp.links l JOIN temp.messages m ON m.ref=l.to_ref WHERE l.from_ref=? AND l.kind='sent_message' AND m.is_self_sent=1 ORDER BY m.time_ms,m.ref").all(`call:${parts[2]}/entry:${parts[3]}/part:${parts[4]}`) as { ref: string; message_id: string; time_ms: number }[]).map(message => ({ ref: message.ref, messageId: message.message_id, timeMs: message.time_ms })), results: call.resultKeys.flatMap(resultKey => {
          const parts = JSON.parse(resultKey) as (string | number)[];
          const result = readItem(`result:${parts[2]}/entry:${parts[3]}`);
          return result ? [publicValue(result)] : [];
        }),
      }];
    });
    return preview({ ...publicValue(output), tools });
  };
  const executeSql = (statement: string, params: SqlValue[]): Record<string, SqlValue>[] => {
    if (typeof statement !== 'string') fail('invalid_options', 'SQL must be a string');
    checkBytes(statement, limits.sqlBytes, 'SQL');
    if (params.some(value => value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value)))) fail('invalid_options', 'SQL parameters must be finite numbers, strings or null');
    authorizeSql(statement);
    const prepared = sqlite.prepare(statement);
    if (!prepared.readonly || !prepared.reader) fail('sql_denied', 'SQL must return rows and be read-only');
    const rows: Record<string, SqlValue>[] = [];
    let bytes = 0;
    for (const row of prepared.iterate(...params) as Iterable<Record<string, unknown>>) {
      if (rows.length >= limits.sqlRows) fail('budget_exceeded', 'SQL row budget exceeded; use an explicit LIMIT or aggregate');
      const normalized: Record<string, SqlValue> = {};
      for (const [key, value] of Object.entries(row)) {
        if (value !== null && typeof value !== 'string' && typeof value !== 'number') fail('invalid_result', 'SQL results must be JSON scalars; convert BLOB values with hex()');
        normalized[key] = value as SqlValue;
      }
      bytes += Buffer.byteLength(JSON.stringify(normalized));
      if (bytes > limits.sdkBytes) fail('budget_exceeded', 'SQL byte budget exceeded');
      rows.push(normalized);
    }
    return rows;
  };
  const thread = (options: Filter & PageOptions = {}) => {
    const limit = integer(options.limit, 10, limits.pageSize, 'limit');
    const sig = signature('thread', filterSignature(options, limit)); const offset = pageStart(options.cursor, sig);
    const { where, params } = filterWhere(options);
    // Select assembly units first. Matching tool rows identify their output;
    // DISTINCT prevents a group from crossing or reappearing on a page.
    const units = sqlite.prepare(`WITH matches AS (SELECT u.unit_ref AS ref,json_group_array(r.ref) AS matching_refs FROM temp.records r JOIN temp.__history_units u ON u.ref=r.ref WHERE ${where} GROUP BY u.unit_ref)
      SELECT r.*,m.matching_refs FROM matches m JOIN temp.records r ON r.ref=m.ref ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit + 1, offset) as (RecordRow & { matching_refs: string })[];
    const more = units.length > limit;
    return { items: units.slice(0, limit).map(row => ({ ...grouped(readItem(row.ref)!) as Record<string, unknown>, matchedRefs: JSON.parse(row.matching_refs) as string[] })), nextCursor: more ? cursorFor(sig, offset + limit) : null };
  };
  const search = (text: string, options: Filter & PageOptions = {}) => {
    if (typeof text !== 'string' || text.length === 0) fail('invalid_options', 'Search text must be nonempty');
    checkBytes(text, limits.sqlBytes, 'Search text');
    const limit = integer(options.limit, 10, limits.pageSize, 'limit');
    const sig = signature('search', [text, filterSignature(options, limit)]); const offset = pageStart(options.cursor, sig);
    const { where, params } = filterWhere(options);
    const fts = [...text].length >= 3;
    const literal = fts ? `"${text.replaceAll('"', '""')}"` : `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const rows = sqlite.prepare(fts
      ? `SELECT r.*,f.rank AS rank,snippet(f.records_fts,0,'[',']','…',24) AS snippet FROM temp.records r JOIN temp.records_fts f ON f.rowid=r.id WHERE f.records_fts MATCH ? AND r.id IN (SELECT id FROM temp.records WHERE ${where}) ORDER BY f.rank,${order} LIMIT ? OFFSET ?`
      : `SELECT *,NULL AS rank,substr(text,max(1,instr(text,?)-48),160) AS snippet FROM temp.records WHERE text LIKE ? ESCAPE '\\' AND ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...(fts ? [literal] : [text, literal]), ...params, limit + 1, offset) as (RecordRow & { rank: number | null; snippet: string })[];
    return {
      items: rows.slice(0, limit).map(row => ({
        ref: row.ref, kind: row.kind, timeMs: row.time_ms, snippet: row.snippet, rank: row.rank, senderId: row.sender_id, messageId: row.message_id, toolName: row.tool_name, parentRef: row.parent_ref, callRef: row.call_ref,
        ...(row.kind === 'summary' ? { coverage: (readItem(row.ref) as Extract<HistoryItem, { kind: 'summary' }>).coverage } : {}),
      })), nextCursor: rows.length > limit ? cursorFor(sig, offset + limit) : null,
    };
  };
  const statusFor = (ref: string): string => {
    if (readItem(ref, false)) return 'redacted';
    if (!/^message:.+|^(?:output|result):[1-9]\d*\/entry:\d+$|^call:[1-9]\d*\/entry:\d+\/part:\d+$|^summary:[1-9]\d*$/.test(ref)) return 'not_found';
    // Observations prove only current-chat membership; foreign rows never
    // participate in status. Unscanned membership remains unknown.
    const match = /^(output|call|result|summary):(\d+)(?:\/entry:\d+(?:\/part:\d+)?)?$/.exec(ref);
    const observed = match ? sqlite.prepare('SELECT 1 FROM history_source_observations WHERE generation=? AND chat_id=? AND source_kind=? AND source_key=?').get(scope.generation, scope.chatId, match[1] === 'summary' ? 'compactions' : 'turn_responses_v2', match[2]) : ref.startsWith('message:') ? sqlite.prepare('SELECT 1 FROM history_event_targets WHERE generation=? AND chat_id=? AND message_id=?').get(scope.generation, scope.chatId, ref.slice(8)) : undefined;
    const foreign = match ? sqlite.prepare('SELECT 1 FROM history_source_observations WHERE generation=? AND chat_id<>? AND source_kind=? AND source_key=?').get(scope.generation, scope.chatId, match[1] === 'summary' ? 'compactions' : 'turn_responses_v2', match[2]) : ref.startsWith('message:') ? sqlite.prepare('SELECT 1 FROM history_event_targets WHERE generation=? AND chat_id<>? AND message_id=?').get(scope.generation, scope.chatId, ref.slice(8)) : undefined;
    if (foreign && !observed) return 'not_found';
    return observed || snapshot.index.phase === 'not_indexed' || snapshot.index.phase === 'building' ? 'not_indexed' : 'not_found';
  };
  const eventContext = (ref: string, options: ContextOptions) => {
    const id = Number(ref.slice(6));
    if (!Number.isSafeInteger(id) || id < 1) return { status: 'not_found' };
    const revisions = sqlite.prepare('SELECT archive_revision AS revision,message_id AS messageId FROM history_message_revisions WHERE generation=? AND chat_id=? AND event_id=?').all(scope.generation, scope.chatId, id) as { revision: string; messageId: string }[];
    const known = sqlite.prepare("SELECT revision FROM history_source_observations WHERE generation=? AND chat_id=? AND source_kind='events' AND source_key=?").get(scope.generation, scope.chatId, String(id)) as { revision: string } | undefined;
    // The source connection is short-lived and never exposed to script SQL.
    const archive = new Database(scope.archivePath, { readonly: true, fileMustExist: true });
    try {
      const reader = createHistoryArchive(drizzle(archive, { schema: archiveSchema }));
      const row = reader.readEvents({ bounds: { chatId: scope.chatId, upperIds: { events: id, turn_responses_v2: 0, compactions: 0 } }, exactId: id, limit: 1, maxBytes: limits.sdkBytes }).rows[0];
      if (!row || !['message', 'edit', 'delete'].includes(row.event.type)) return { status: 'not_found' };
      if (revisions.length === 0) {
        const messageId = 'messageId' in row.event ? row.event.messageId : undefined;
        return { status: known && messageId && readItem(`message:${messageId}`, false) ? 'source_changed' : 'not_indexed' };
      }
      if (revisions.some(revision => row.revision !== revision.revision)) return { status: 'source_changed' };
      const targets = row.event.type === 'delete' ? row.event.messageIds : 'messageId' in row.event ? [row.event.messageId] : [];
      if (targets.some(messageId => !revisions.some(revision => revision.messageId === messageId))) return { status: 'not_indexed' };
      if (targets.some(messageId => { const target = readItem(`message:${messageId}`, false); return target && !snapshot.visible(target); })) return { status: 'redacted' };
      // Reuse Projection + shared rendering for standalone evidence. Edits are
      // source content, not an invented reconstructed historical transcript.
      if (row.event.type !== 'message') return { status: 'ok', sourceRef: ref, evidence: preview({ type: row.event.type, ...('content' in row.event ? { content: row.event.content } : { messageIds: targets }) }), snapshotRelation: 'independently_verified' };
      const ic = reduce(createEmptyIC(scope.chatId), row.event);
      const source = updateMessageSource(undefined, row)!;
      const items = buildMessageItems(ic, new Map([[row.event.messageId, source]]), { botUserId: scope.renderParams?.botUserId, contactNames: new Map(scope.renderParams?.contactNames) });
      const item = items[0];
      if (!item || !snapshot.visible(item)) return { status: 'redacted' };
      return { status: 'ok', sourceRef: ref, target: preview(publicValue(item)), ...textWindow(item, options), snapshotRelation: 'independently_verified' };
    } finally { archive.close(); }
  };
  const textWindow = (item: HistoryItem, options: ContextOptions) => {
    if (options.offset === undefined && options.maxChars === undefined) return {};
    const text = searchableText(item);
    const offset = integer(options.offset, 0, Number.MAX_SAFE_INTEGER, 'offset', 0);
    const maxChars = integer(options.maxChars, 2000, limits.sdkBytes, 'maxChars');
    let length = 0; let window = '';
    for (const point of text) { if (length >= offset && length < offset + maxChars) window += point; length++; }
    const end = Math.min(length, offset + maxChars);
    return { fullText: { status: 'ok', text: window, totalLength: length, offset, nextOffset: end < length ? end : null } };
  };
  const context = (ref: string, options: ContextOptions = {}) => {
    if (typeof ref !== 'string') fail('invalid_options', 'Reference must be a string');
    if (ref.startsWith('event:')) return eventContext(ref, options);
    const item = readItem(ref);
    if (!item) return { status: statusFor(ref) };
    const before = integer(options.before, 3, limits.neighbors, 'before', 0); const after = integer(options.after, 3, limits.neighbors, 'after', 0);
    const limit = integer(options.limit, 10, limits.pageSize, 'limit');
    const sig = signature('relations', [ref, { limit, before, after, offset: options.offset ?? null, maxChars: options.maxChars ?? null }]); const offset = pageStart(options.cursor, sig);
    const relations = sqlite.prepare('SELECT * FROM temp.links WHERE from_ref=? OR to_ref=? ORDER BY kind,from_ref,to_ref LIMIT ? OFFSET ?').all(ref, ref, limit + 1, offset) as { from_ref: string; to_ref: string; kind: string }[];
    const units = '(SELECT r.* FROM temp.records r JOIN temp.__history_units u ON u.ref=r.ref AND u.unit_ref=r.ref)';
    const rootRef = (sqlite.prepare('SELECT unit_ref FROM temp.__history_units WHERE ref=?').get(ref) as { unit_ref: string }).unit_ref;
    const root = readItem(rootRef)!;
    const timeKey = [root.order.timeMs, root.order.sourceOrder, root.order.sourceId, root.order.entryIndex, root.order.partIndex];
    const prior = sqlite.prepare(`SELECT ref FROM ${units} WHERE (${order}) < (?,?,?,?,?) ORDER BY time_ms DESC,source_order DESC,source_id DESC,entry_index DESC,part_index DESC LIMIT ?`).all(...timeKey, before) as { ref: string }[];
    const following = sqlite.prepare(`SELECT ref FROM ${units} WHERE (${order}) > (?,?,?,?,?) ORDER BY ${order} LIMIT ?`).all(...timeKey, after) as { ref: string }[];
    const range = item.kind === 'summary' ? { afterMs: item.coverage.fromReceivedAtMs, beforeMs: item.coverage.untilReceivedAtMs, kinds: ['message', 'assistant_text', 'tool_call', 'tool_result'] as RecordKind[] } : null;
    return {
      status: 'ok', requestedRef: ref, target: item.kind === 'tool-execution' || item.kind === 'tool-result' ? { ...preview(publicValue(item)), output: grouped(item) } : grouped(item), ...textWindow(item, options),
      relations: { items: relations.slice(0, limit).map(link => ({ kind: link.kind, fromRef: link.from_ref, toRef: link.to_ref, target: grouped(readItem(link.from_ref === ref ? link.to_ref : link.from_ref)!) })), nextCursor: relations.length > limit ? cursorFor(sig, offset + limit) : null },
      window: [...prior.reverse(), ...following].map(row => grouped(readItem(row.ref)!)),
      ...(range ? { coverage: snapshot.index.coverage, coveredWindow: thread({ ...range, limit }), threadFilter: range, sourceRefs: [], previousSummaryRef: null } : {}),
    };
  };
  const invoke = (operation: string, args: unknown[]): unknown => {
    budget.call();
    try {
      let value: unknown;
      switch (operation) {
      case 'search': value = search(args[0] as string, args[1] as Filter & PageOptions | undefined); break;
      case 'thread': value = thread(args[0] as Filter & PageOptions | undefined); break;
      case 'context': value = context(args[0] as string, args[1] as ContextOptions | undefined); break;
      case 'sql': value = executeSql(args[0] as string, args.slice(1) as SqlValue[]); break;
      default: return fail('invalid_options', 'Unknown SDK operation');
      }
      return budget.charge(value);
    } catch (error) {
      if (error instanceof HistorySourceBudgetError) {
        const failure = new QueryError('budget_exceeded', 'Source evidence byte budget exceeded');
        budget.record(failure);
        throw failure;
      }
      if (error instanceof Error && 'code' in error && (error.code === 'SQLITE_NOMEM' || error.code === 'SQLITE_TOOBIG')) {
        const failure = new QueryError('budget_exceeded', 'Native SQLite memory budget exceeded');
        budget.record(failure);
        throw failure;
      }
      budget.record(error);
      throw error;
    }
  };
  return { invoke, assertBudget: budget.assert, metrics: budget.metrics };
};
