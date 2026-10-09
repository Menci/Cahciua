# Historical archive input and durable bootstrap

Implemented scope: archive input construction and a resumable, bounded offline/bootstrap materialization into an independent, rebuildable `history.db`. The larger history-retrieval design remains incomplete: live mutation logs, reconciliation, IPC, automatic startup synchronization and query services are deferred.

`src/db/history-archive.ts` owns archive IDs, row fingerprints, per-chat fences and indexed keyset reads. `src/projection/dependencies.ts` declares the targets read by the pure reducer. `src/history/` owns sparse dependency restoration, shared rendering/IR expansion, saved items, history schema/migrations, atomic writer and bootstrap scheduling. These consumers do not read online Pipeline, Driver compaction residency, visibility transforms, Telegram clients or LLM transports.

## Standalone bootstrap

Apply the source archive's normal Drizzle migrations, including `0033_history_archive_inputs`, first. Start this command independently of the bot process:

```sh
pnpm exec tsx src/history/cli.ts \
  --archive data/bot.db --history data/history.db \
  --generation initial --chat=-100123 --chat=-100456
```

Use `--chat=<id>` for negative Telegram IDs. One history file serves every specified chat; all saved items, state, notices, relationships and checkpoints are isolated by generation and `chat_id`. The CLI opens the archive read-only and migrates only history.db using `history-drizzle/`. It refuses identical files and refuses to migrate an archive as a history database. The bot process has no new startup await or worker registration.

The command processes chats sequentially and emits JSON slice reports: committed source row count, scan completion, peak dependency entries, encoded workspace bytes and sampled RSS. SIGINT/SIGTERM stop at a row/transaction boundary. Restart with the same arguments to continue from committed checkpoints. After a scan completes, the same generation does no source replay. A new generation explicitly rebuilds the captured archive, keeping older generations separate; generation switching/cleanup is not automatic.

The archive identity (CLI: canonical path), Projection version and display/cache-policy identity belong to the generation. Mismatches fail and require a new generation. These identities prevent accidentally resuming against another source or formatter; the path is not a byte-immutability guarantee. Do not replace the source file underneath an existing generation.

The programmatic entry is `buildHistorySlice({ archive, store, generation, chatId, archiveIdentity, renderIdentity, limits, ... })`; `openHistoryStore(path)` provides the real writer and dependency adapter. Caller-owned archive/history connections must close after use. The optional media hydrator receives a reservation callback; reserve cached description bytes before attaching them. CLI cache lookup preflights stored alt-text size and uses the shared cache-only hydrator without model calls.

`buildHistoryInput()` remains a lower-level in-memory reference consumer. It starts at the origin and retains all dependencies; its saved source cursor alone cannot resume it. The durable entry uses the same reducer, shared `buildMessageItems`, `buildTurnItems` and explicit bash task identity helper, with on-disk dependencies and its writer. Do not substitute the reference generator for the bounded bootstrap.

## Fences and transactional recovery

First initialization captures all three source maximum row IDs for one chat in a short archive read transaction, then persists all fences atomically in history.db. It does not recapture them on later slices. Every source query fixes chat and inclusive ID fence, then seeks after `(source time, row ID)` using a tuple comparison and the matching composite index with `INDEXED BY`. Events use `received_at`, TR uses `requested_at`, compactions use `created_at`. Tied timestamps survive boundaries; new/backdated inserts after capture stay outside this generation.

Checkpoints are keyed by `(generation, chat_id, source_kind)` and hold `upper_id`, the committed keyset and `scan_complete`; the generation stores the Projection version. Rendering ranges never serve as checkpoints. Each row is one atomic batch, with a possible empty terminal batch marking source exhaustion. Slices group a bounded number of these transactions for scheduling/reporting; changing slice size cannot change row-level semantics.

TR scans precede event scans so explicit task starts are persisted before completion events. Compactions have their own scan and every summary is retained. Emission/processing order differs from saved timeline order.

The writer commits saved items, outgoing relations, FTS trigger updates, changed message/user/chat state, provenance revisions, task starts/notices and source checkpoint in the **same history transaction**. SQLite rollback applies to all of them. A checkpoint compare-and-swap rejects stale plans from concurrent builders. Reapplying a just-committed plan is a no-op, including user counts and revision chains. After an exception or process exit before commit, the failed row remains pending. After commit, the next process reads strictly after that row and restores only its needed targets; it does not replay the completed prefix.

A single builder writer is the intended deployment. CAS prevents stale double application; multi-worker scheduling is not implemented. Source reads release their snapshot before asynchronous TR decoding, Projection/rendering, history writes and throttling. There is no long archive read transaction pinning WAL across bootstrap.

Fences freeze row membership, **not mutable row contents or media cache values**. Reads over a running source can contain mixed revisions. Previously consumed rows/cache descriptions are not revisited on resume. Use a stable SQLite backup/copy when content must be frozen, or run a new generation after backfills. No durable live log exists, so `scan_complete` only means the three captured fences were scanned; there is no `baselineComplete`, S0/S1 reconciliation, live catch-up or source-absence guarantee for unscanned work.

## Persisted dependencies and bounded workspace

History state is normalized by target:

- `history_message_states`: one structured `ICMessage` plus original/latest source and chained fingerprint per `(generation, chat, message)`, including content/attachments, sender, reply snapshots, quote, forwarding, edit/delete/self-send state and original ordering time. This is dependency data, not display XML or an all-chat blob. Small source thumbnail strings may remain here to preserve shared rendering semantics; saved/search items contain no image bytes.
- `history_user_states`: the reducer's user snapshot, first/last seen times and count per user.
- `history_chat_states`: current title per chat.
- `history_message_revisions`: each contributing event locator/fingerprint, predecessor chain fingerprint and new fingerprint. Historical source versions remain authoritative in the archive.
- `history_task_starts`: explicit task-to-tool identities. Looking up two indexed keys suffices to distinguish unique from ambiguous; only a unique tool item is decoded. All past tasks remain on disk, not in a growing process map.

For each event, the dependency contract requests its existing message, reply target, edit/delete targets or pinned target, and only the message sender's user state. Restore those targets and chat title, run the unchanged pure `reduce()`, persist touched messages/users/title, and discard system/runtime nodes after the step. Unknown targets stay unknown, as in full replay. Deleted messages remain restorable. Replies retain their creation-time content/sender snapshot despite later edits/deletes. Synthetic self-send/echo updates restore the old message and preserve the reducer's original ordering/self-send semantics.

Rendering receives only touched, projected messages and their explicit received-time range, so unrelated equal-time nodes cannot inflate output. Its cache is released in `finally` after each rendering pass. No decoded dependencies, source rows or task map persist across rows/slices; only one row's state/output is retained while it commits. Full saved transcript text/XML and reply snapshots come from the shared formatter, separately from unchanged runtime previews/tombstones. No identity is parsed from XML.

Default CLI/API limits:

| Limit | Default | Enforcement |
| --- | ---: | --- |
| Encoded source bytes | 2 MiB | SQLite byte-length preflight in the same short snapshot as fetch, before JSON/IR/Sharp decoding |
| Dependency lookups | 256 | Count each message/user/task lookup before reading |
| Workspace budget | 32 MiB | Reserve serialized source/cache/state/plan bytes with a 16x expansion allowance; state byte preflight precedes JSON decoding |
| Saved items per source | 4,096 | Guard IR expansion and final change count |
| Source rows per slice | 64 | Stop at committed row boundaries |
| Processing rate | 100 rows/sec | Wait/yield after every row; decoding/rendering concurrency is one |
| SQLite page cache | 2 MiB per CLI connection | `cache_size=-2048`; temporary work spills to disk |

CLI overrides are `--source-bytes`, `--state-entries`, `--workspace-bytes`, `--output-items`, `--rows-per-slice`, `--rows-per-second`; all require positive safe integers. The effective encoded-source limit also reserves workspace expansion room. Limits are operational budgets, not model-token truncation. Oversized rows, multi-target deletes or recovered dependencies fail with generation/chat/source/checkpoint and a cause; the row remains pending, with full original content intact. Increase budgets or revise the work strategy and resume explicitly. Nothing is silently skipped or permanently truncated.

Serialized byte accounting and its expansion allowance bound retained content, not exact V8/native RSS. Strings, object overhead, codec/Sharp internals, SQLite caches and allocator/GC behavior affect RSS; the CLI reports it separately. A maximum supported single row remains a lower bound on required memory. Existing archive readers without `maxBytes` and the reference generator do not have the durable entry's guarantees.

## Saved items, FTS and relationships

`history_items` stores the unchanged JSON-safe `HistoryItem` contract and indexed stable timeline columns. Full message text, reply snapshot, output text, tool name/arguments/completion summary, result payload text and every compaction summary form `search_text`. `history_fts` is an FTS5 external-content table with transactional insert/update/delete triggers in the initial migration. FTS indexes complete content, independent of token budgets and online compaction. The trigger DDL is intentional custom SQL alongside the generated Drizzle schema; future changes need a new history migration.

These are private, unmasked data. Deleted bodies remain internal dependencies/search content; no public search/visibility policy is implemented here. A future query layer must apply current chat and visibility policy. The raw FTS index is shared across generations/chats; future queries must join/filter history_items to the requested scope. This change supplies no unrestricted model SQL interface.

Outgoing reply/output/tool/result edges are replaced on each stable-key upsert. A reply target can be absent from the observed archive; the explicit locator is retained without fabricating a target record. Ambiguous tool pairing emits no invented call/result edges. Task completion stores the full event locator, fingerprint, task metadata and summary in its uniquely identified tool item. Notices persist separately. Relationships do not infer wakeup causality, previous summaries or summary source rows.

Message keys are `(chatId, messageId)`; origin is the first message event and changedBy is latest consumed evidence. Archive row SHA-256 fingerprints chain into `sourceRevision`. TR keys include original TR/entry/part positions, even when reasoning/images are omitted. Matched call/result association stays inside one TR's callId; reuse across TRs never links them. Full readable arguments/results and follow-up flags survive. Image result parts carry original locators, not bytes; provider extras and reasoning never enter saved items. Only the bash result's explicit positive numeric `background_task_id` establishes a start.

Every compaction row becomes a stable summary with complete text, source ID, chat, creation time and `[oldCursorMs,newCursorMs)` coverage. The current archive records neither previous-summary ID nor exact input references; no relationship is invented. Timeline order is `(timeMs, sourceOrder, sourceId, entryIndex, partIndex)`: original message received time/rank 0, TR requested time/rank 1, summary creation time/rank 2. Summary coverage and generation/bootstrap positions remain separate concepts.

Migration `0033_history_archive_inputs` persists explicit reply quotes for future events. Previously unrecorded quotes cannot be reconstructed. This round changes no source schema and introduces no runtime legacy fallback.

## Verification and remaining work

`build-input.test.ts` characterizes the production archive input path and one-shot Projection/rendering parity. `bootstrap.test.ts` migrates real disk SQLite files and compares this reference with uninterrupted and every-row-restarted durable builds, different slice sizes, cross-chat/generation isolation, tied times, fences, old edits/deletes/replies/quotes/echoes, user/chat state, revision chains, explicit/ambiguous task starts, all summaries and full FTS/relations. It checks writer failure rollback, repeated commit idempotence, actual process exit inside a writer transaction, resumption without rereading a committed prefix, standalone CLI, byte/output/dependency failures and indexed query plans.

A repeatable scale fixture grows from 300 to 3,000 unique messages/users. A standalone run measured 2 peak dependency lookups for both sizes and 3,252 / 3,305 encoded workspace bytes, with approximately 0.64 / 6.41 seconds of build time. Sampled process RSS was 217,415,680 / 154,173,440 bytes and includes fixture setup, loaded dependencies and allocator/GC effects; it is not the workspace byte limit. These measurements separate dependency residency from SQL page size and total RSS. They are fixture evidence, not production archive benchmarking.

Deferred: durable live mutation log, S0/S1 reconciliation, bounded rendering IPC, automatic startup/catch-up lifecycle, generation promotion/cleanup, query authorization/SQL guard, search/thread/context/sql SDK, long-term memory and vector/complex retrieval. The standalone bootstrap closes persistence/restart/eviction for captured offline inputs without claiming the full design is complete.
