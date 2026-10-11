# History query SDK

Implemented on 2026-10-11, stacked on `codex/history-online` at `005ff4ae7d0378777f5626b991d1c0b9422002aa`. This is the query layer over the existing independent writer. It does not deploy or enable history automatically. Long-term memory and new compaction provenance remain separate work.

`history_query({ code })` accepts an async JavaScript function body. Driver supplies the current chat; the model supplies neither paths, generation, chat ID, policy nor limits. Only primary receives the tool and its SDK/schema instructions when the startup `history.enabled` capability is enabled. Probe remains an outside judge with only `decide`. Query results require follow-up and persist as normal tool call/result IR in TR. They never mutate IC or activate Driver.

## Snapshot and lifetime

History runtime owns per-chat serialized query execution and binds the same generation identity as its writer. Each execution forks a disposable process, resolves current configured-chat and blocked-user policy, opens history.db read-only, begins and pins one committed read transaction, and constructs TEMP public views. Policy is evaluated once into authorized row IDs; only JSON-safe authorized public fields are materialized into SQLite file-backed TEMP tables with relation indexes. A one-row decode cache avoids repeatedly decoding the same dependency. The process never loads a chat-sized unmasked JavaScript array. Every helper and SQL call uses that connection. Queries do not wait for readiness, catch-up, media transforms, IPC ACKs or builder responses. Writer commits continue under WAL; the current script retains its snapshot. Cursors expire with that process; stable refs survive rebuilds and executions.

The runtime stops queued queries and kills active children during shutdown. Parent deadlines cover process startup, synchronous SQLite work and JavaScript. A result is delivered only after child `close`, releasing snapshots and locks. QuickJS supplies no Node globals, module loader, filesystem, sockets or host object handles. Its bridge captures four immutable JSON-only async functions and removes the host bridge from the global object. Promise.all uses the same serialized SQLite connection.

Default limits are code and SQL 16 KiB each, 10 seconds, QuickJS heap 32 MiB, 30 SDK calls, 1,000 returned SQL rows, helper pages at most 50, neighbors at most 20 each, cumulative SDK JSON 128 KiB, and final JSON including index status 24 KiB. Dedicated children also set SQLite's process-wide hard heap quota to 32 MiB and Node's old-space limit to 64 MiB. These are separate allocator limits, not a total RSS claim. SQL inputs to aggregates are not sampled and LIMIT is never injected. Budget errors remain fatal even when the script catches them. Memory, row, byte and deadline failure return explicit statuses rather than partial success.

## Four methods

```ts
type SqlValue = string | number | null;
type RecordKind = 'message' | 'assistant_text' | 'tool_call' | 'tool_result' | 'summary';
type Filter = { kinds?: RecordKind[]; senderId?: string; toolName?: string; afterMs?: number; beforeMs?: number };
type PageOptions = { limit?: number; cursor?: string };

search(text: string, options?: Filter & PageOptions): Promise<{ items: Hit[]; nextCursor: string | null }>;
thread(options?: Filter & PageOptions): Promise<{ items: TimelineItem[]; nextCursor: string | null }>;
context(ref: string, options?: PageOptions & { before?: number; after?: number; offset?: number; maxChars?: number }): Promise<Context>;
sql(statement: string, ...params: SqlValue[]): Promise<Record<string, SqlValue>[]>;
```

Time ranges use inclusive `afterMs`, exclusive `beforeMs`. No default kind or sender filter excludes summaries. Search treats input literally: three or more Unicode code points use escaped trigram MATCH; one or two use escaped substring LIKE. Rank is SQLite's shared-corpus statistic; returned rows, snippets and counts remain scoped. Equal rank uses the stable timeline key `(time_ms, source_order, source_id, entry_index, part_index)`.

Thread pages assembly units before expansion. Calls and uniquely matched results remain under their original output, including outputs containing only calls. Filtered tool hits carry `matchedRefs`. Orphan results remain independent; ambiguous call IDs never invent pairing. Confirmed send_message results create a `sent_message` edge by final server ID. A linked self-sent message maps to that output in thread, retaining its identity under `tools[].sentMessages` without repeating the body. Exact message context still returns that message. No text/time heuristic creates a link.

Context returns `requestedRef`, precise `target`, paged `relations`, and bounded `window`. Call/result targets include their output and complete tools/results. Summary context supplies `coveredWindow`, `[oldCursorMs,newCursorMs)` `threadFilter`, and coverage for continuation. The archive does not record exact summary input refs or parent IDs: `sourceRefs=[]` and `previousSummaryRef=null` mean absent evidence. Time adjacency never becomes inheritance or causality.

Each preview truncates individual strings at 1,200 code points and reports paths/total lengths in `previewTruncated`; storage is complete. Explicit `offset`/`maxChars` adds `fullText` with text, totalLength, offset and nextOffset measured in Unicode code points. SQL returns complete scalar fields or fails its budget. Images and reasoning bodies are omitted; omission metadata is explicit where recorded, and NULL where an older offline generation has no such metadata.

Stable references are `message:ID`, `output:TR/entry:N`, `call:TR/entry:N/part:N`, `result:TR/entry:N`, and `summary:ID`. Explicit `context('event:ID')` opens a short independent read-only source connection for message/edit/delete evidence, checks current chat, policy and every materialized target revision, and returns `source_changed` or `not_indexed` rather than merging newer source fields into an older transcript. Its successful result says `snapshotRelation='independently_verified'`; the two databases do not form an atomic snapshot. Runtime/service events are not exposed.

## Public SQL schema and guard

All tables are TEMP views authorized by a full-tree SQLite grammar parser pinned to sqlite3-parser 0.7.1. Original SQL is prepared unchanged after authorization. The guard recognizes lexical CTE scopes (including safe public-name shadowing), compound arms, subqueries, IN-table syntax, schema qualification and JSON table functions. Only one SELECT/WITH statement is accepted. `temp` qualification is allowed only for public tables. Private `history_*`, `__*`, sqlite schema/shadow tables, private index selection, arbitrary table functions, ATTACH, PRAGMA, writes, filesystem/extension functions and multiple statements are rejected. An explicit function allowlist retains normal expressions, aggregates, windows, date/math, JSON and FTS. Native `readonly`/`reader` validation and `query_only` supplement AST authorization.

| View | Columns |
| --- | --- |
| records | id, ref, kind, time_ms, source_order, source_id, entry_index, part_index, text, sender_id, message_id, tool_name, parent_ref, call_ref |
| records_fts | rowid, text, rank, records_fts |
| messages | ref, chat_id, message_id, source_event_id, time_ms, timestamp_sec, edited_at, sender_id, sender_json, reply_json, reply_to_ref, forward_json, deleted, is_self_sent, body_json, rendered_text, text, source_refs_json |
| outputs | ref, chat_id, step_ref, entry_index, time_ms, model_name, body_json, text, omitted_json |
| executions | step_ref, chat_id, time_ms, model_name, usage_json |
| tool_calls | ref, chat_id, output_ref, step_ref, part_index, call_id, tool_name, args_json, args_text, result_ref, result_refs_json, completion_json, time_ms |
| tool_results | ref, chat_id, call_ref, output_ref, step_ref, entry_index, call_id, tool_name, payload_json, result_json, text, requires_follow_up, time_ms |
| summaries | ref, chat_id, summary, old_cursor_ms, new_cursor_ms, created_at, previous_summary_ref, source_refs_json, usage_json |
| links | from_ref, to_ref, kind |

JSON columns contain valid JSON or NULL. A string tool payload stays a JSON string in payload_json; result_json additionally exposes valid embedded JSON. Invalid tool argument JSON remains in args_text with args_json=NULL. Parameters are bound scalars, never interpolated. BLOB results must be converted explicitly, for example with hex(). Aliased FTS uses `f.records_fts` for MATCH/snippet and `f.rank`. FTS's opaque virtual-table handle is preserved through the public view; its private table name remains unauthorized.

Scope/policy is one boundary before helper, JSON, FTS, COUNT and relation exposure. Deleted messages and blocked senders are withheld. Known identity fields, reply identities, blocked XML identity and copies of hidden complete transcript text also withhold containing rows; a sensitive member withholds the entire TR assembly. Relations expose only visible endpoints. This deliberately conservative row policy can hide an otherwise normal reply/output. It identifies recorded identity and exact copied content, not semantic attribution of arbitrary paraphrases; the current archive has no provenance for those. Include-deleted is host-only and unused by the bot. Query policy is rebound for the next child, never cached across executions.

The outer `index` contains current-chat phase, baselineComplete, three-source coverage, indexedThrough observation prefix, observed source IDs/poll time and last-observed lag. Sequence numbers are not historical time windows. `baselineComplete` requires all three source scans plus the online baseline consumer. An empty building search does not prove absence. Missing observed current-chat refs return not_indexed; foreign refs return not_found; known withheld refs return redacted. Unscanned unknown membership may return not_indexed. Missing database/query migration returns index_not_ready. No status triggers synchronous building.

## Migration and examples

History-only migration 0007 adds execution metadata, changes FTS to trigram and rebuilds it, and enqueues existing online turns/summaries through the bounded consumer to refresh usage, omissions and sent-message edges. Core archive schema is unchanged. The FTS rebuild is a migration operation and can take time on a large existing index; queries are unavailable until it commits. Completed offline generations require a new build to gain metadata that was never stored; readers use NULL rather than inventing values or runtime legacy conversion.

```js
const hits = await search('运行时升级', { kinds: ['summary'], limit: 1 });
if (!hits.items.length) return hits;
const node = await context(hits.items[0].ref, { before: 0, after: 0, limit: 3 });
return { summary: node.target, evidence: node.coveredWindow, continueWith: node.threadFilter };
```

```js
return await sql("SELECT r.ref,snippet(f.records_fts,0,'[',']','…',24) AS excerpt FROM records_fts f JOIN records r ON r.id=f.rowid WHERE f.records_fts MATCH ? ORDER BY f.rank,r.time_ms,r.ref LIMIT 5", '"构建失败" OR "error"');
```

```js
return await sql('SELECT sender_id,count(*) AS n FROM messages GROUP BY sender_id ORDER BY n DESC');
```

The existing read_old_messages tool remains independently available with history disabled. Both paths use the common pure Projection and rendering contracts; the new query does not introduce another message formatter. See [acceptance evidence](history-query-acceptance-2026-10-11.md) for actual subprocess, SQLite, Driver and Docker checks.
