# Historical archive input, durable bootstrap and online synchronization

Implemented scope: archive input construction and a resumable, bounded offline/bootstrap materialization into an independent, rebuildable `history.db`. The online writer, history-owned observation queue, reconciliation, bounded IPC and startup/shutdown lifecycle are implemented. Query worker/SDK, SQL guard and long-term memory remain deferred; see [the retrieval design](history-retrieval-design.md).

`src/db/history-archive.ts` owns archive IDs, row fingerprints, per-chat fences and indexed keyset reads. `src/projection/dependencies.ts` declares the targets read by the pure reducer. `src/history/` owns sparse dependency restoration, shared rendering/IR expansion, saved items, history schema/migrations, atomic writer and bootstrap scheduling. These consumers do not read online Pipeline, Driver compaction residency, visibility transforms, Telegram clients or LLM transports.

## Asynchronous synchronization contract

The [asynchronous synchronization design](history-sync-design.md) is now implemented for archive discovery, reliable rendering work and media completion delivery. The entire core path never waits for History, including durable-receipt ACKs. All durable tasks, dependencies, delivery recovery and backpressure belong to History. Shared rendering is scheduled by the History consumer; Pipeline no longer publishes rendering hints. Query workers/SDK, SQL guard and memory remain deferred.

## Standalone bootstrap

Use the deployed core archive schema; this feature adds no source migrations. Start this command independently of the bot process:

```sh
pnpm exec tsx src/history/cli.ts \
  --archive data/bot.db --history data/history.db \
  --generation initial --chat=-100123 --chat=-100456
```

Use `--chat=<id>` for negative Telegram IDs. One history file serves every specified chat; all saved items, state, notices, relationships and checkpoints are isolated by generation and `chat_id`. The CLI opens the archive read-only and migrates only history.db using `history-drizzle/`. It refuses identical files and refuses to migrate an archive as a history database. The offline CLI remains independent; the bot additionally launches its own online history child without awaiting readiness or progress.

The command processes chats sequentially and emits JSON slice reports: committed source row count, scan completion, peak dependency entries, encoded workspace bytes and sampled RSS. SIGINT/SIGTERM stop at a row/transaction boundary. Restart with the same arguments to continue from committed checkpoints. After a scan completes, the same generation does no source replay. A new generation explicitly rebuilds the captured archive, keeping older generations separate; generation switching/cleanup is not automatic.

The archive identity (CLI: canonical path), Projection version and display/cache-policy identity belong to the generation. Mismatches fail and require a new generation. These identities prevent accidentally resuming against another source or formatter; the path is not a byte-immutability guarantee. Do not replace the source file underneath an existing generation.

The programmatic entry is `buildHistorySlice({ archive, store, generation, chatId, archiveIdentity, renderIdentity, limits, ... })`; `openHistoryStore(path)` provides the real writer and dependency adapter. Caller-owned archive/history connections must close after use. The optional media hydrator receives a reservation callback; reserve cached description bytes before attaching them. CLI cache lookup preflights stored alt-text size and uses the shared cache-only hydrator without model calls.

`buildHistoryInput()` remains a lower-level in-memory reference consumer. It starts at the origin and retains all dependencies; its saved source cursor alone cannot resume it. The durable entry uses the same reducer, shared `buildMessageItems`, `buildTurnItems` and explicit bash task identity helper, with on-disk dependencies and its writer. Do not substitute the reference generator for the bounded bootstrap.

## Fences and transactional recovery

First initialization captures all three source maximum row IDs for one chat in a short archive read transaction, then persists all fences atomically in history.db. It does not recapture them on later slices. Every source query fixes chat and inclusive ID fence, then seeks after `(source time, row ID)` using a tuple comparison. The offline reader uses existing source indexes; source schemas without matching ordering indexes may spill sorting to disk. Online builds instead use private history-owned ordering indexes and source primary-key lookups. Events use `received_at`, TR uses `requested_at`, compactions use `created_at`. Tied timestamps survive boundaries; new/backdated inserts after capture stay outside this generation.

Checkpoints are keyed by `(generation, chat_id, source_kind)` and hold `upper_id`, the committed keyset and `scan_complete`; the generation stores the Projection version. Rendering ranges never serve as checkpoints. Each ordinary row is one atomic batch, with a possible empty terminal batch marking source exhaustion. A multi-target delete is split into one existing target per transaction; committed per-message event revisions supply sub-event progress, and its event checkpoint advances only after all targets complete. Slices group a bounded number of these transactions for scheduling/reporting; changing slice size cannot change row-level semantics.

TR scans precede event scans so explicit task starts are persisted before completion events. Compactions have their own scan and every summary is retained. Emission/processing order differs from saved timeline order.

The writer commits saved items, outgoing relations, FTS trigger updates, changed message/user/chat state, provenance revisions, task starts/notices and source checkpoint in the **same history transaction**. SQLite rollback applies to all of them. A checkpoint compare-and-swap rejects stale plans from concurrent builders. Reapplying a just-committed plan is a no-op, including user counts and revision chains. After an exception or process exit before commit, the failed row remains pending. After commit, the next process reads strictly after that row and restores only its needed targets; it does not replay the completed prefix.

A single builder writer is the intended deployment. CAS prevents stale double application; multi-worker scheduling is not implemented. Source reads release their snapshot before asynchronous TR decoding, Projection/rendering, history writes and throttling. There is no long archive read transaction pinning WAL across bootstrap.

Fences freeze row membership, **not mutable row contents or media cache values**. Reads over a running source can contain mixed revisions. Previously consumed rows/cache descriptions are not revisited on resume. Use a stable SQLite backup/copy when content must be frozen, or run a new generation after backfills. For the offline CLI, `scan_complete` only means the three captured fences were scanned. Online builds add a separate durable observation consumer and post-bootstrap incremental catch-up, described below; the CLI does not silently become that consumer.

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
| Encoded source bytes | 64 MiB | SQLite byte-length preflight in the same short snapshot as fetch, before JSON/IR decoding |
| Dependency lookups | 256 | Count each message/user/task lookup before reading |
| Encoded workspace bytes | 128 MiB | Count serialized source/cache/state/plan bytes directly; state byte preflight precedes JSON decoding |
| Saved items per source | 4,096 | Guard IR expansion and final change count |
| Source rows per slice | 64 | Stop at committed row boundaries |
| Processing rate | 100 rows/sec | Wait/yield after every row; decoding/rendering concurrency is one |
| SQLite page cache | 2 MiB per CLI connection | `cache_size=-2048`; temporary work spills to disk |

CLI overrides are `--source-bytes`, `--state-entries`, `--workspace-bytes`, `--output-items`, `--rows-per-slice`, `--rows-per-second`; all require positive safe integers. Effective source preflight is the smaller of source and encoded workspace limits. There is no guessed memory multiplier. Limits bound content in one processing unit, not model-token truncation. Oversized source rows or recovered state fail with generation/chat/source/checkpoint and a cause; the row remains pending, with full original content intact. Increase limits or revise the work strategy and resume explicitly. Nothing is silently skipped or permanently truncated.

Encoded workspace accounting sums bytes for source rows, restored dependencies and the serialized commit plan. Source and output are both charged because they coexist; this deliberately measures retained content, not a fabricated estimate of V8/native RSS. Source preflight prevents allocating an already known oversized row; final plan accounting does not bound every transient formatter/string allocation. The worker reports actual RSS, heapUsed, external and array-buffer samples separately. Single-row processing, finite lookups/items, short transactions and disk-backed fanout bound accumulation across history; Node/SQLite allocation and GC remain separate. Supported large inputs and real archives must be tested with defaults; see the [read-only synchronization acceptance report](history-readonly-acceptance-2026-10-10.md) for repeatable resource and archive checks. Existing archive readers without `maxBytes` and the origin-replaying reference generator do not have the durable entry's content limits.

History TR decoding uses the shared codec with `omitCustomTypes: ['sharp']`. It validates registered tags but does not base64-decode image bytes or create Buffer/Sharp handles. `ArchivedConversationEntry` retains text/tool structure and image kind/detail/position, and deliberately cannot serve as complete provider input. Runtime decoding still restores all registered values. Source fingerprints are computed from the complete stored row; saved image locators and output semantics are unchanged.

## Saved items, FTS and relationships

`history_items` stores the unchanged JSON-safe `HistoryItem` contract and indexed stable timeline columns. Full message text, reply snapshot, output text, tool name/arguments/completion summary, result payload text and every compaction summary form `search_text`. `history_fts` is an FTS5 external-content table with transactional insert/update/delete triggers in the initial migration. FTS indexes complete content, independent of token budgets and online compaction. The trigger DDL is intentional custom SQL alongside the generated Drizzle schema; future changes need a new history migration.

These are private, unmasked data. Deleted bodies remain internal dependencies/search content; no public search/visibility policy is implemented here. A future query layer must apply current chat and visibility policy. The raw FTS index is shared across generations/chats; future queries must join/filter history_items to the requested scope. This change supplies no unrestricted model SQL interface.

Outgoing reply/output/tool/result edges are replaced on each stable-key upsert. A reply target can be absent from the observed archive; the explicit locator is retained without fabricating a target record. Ambiguous tool pairing emits no invented call/result edges. Task completion stores the full event locator, fingerprint, task metadata and summary in its uniquely identified tool item. Notices persist separately. Relationships do not infer wakeup causality, previous summaries or summary source rows.

Message keys are `(chatId, messageId)`; origin is the first message event and changedBy is latest consumed evidence. Archive row SHA-256 fingerprints chain into `sourceRevision`. TR keys include original TR/entry/part positions, even when reasoning/images are omitted. Matched call/result association stays inside one TR's callId; reuse across TRs never links them. Full readable arguments/results and follow-up flags survive. Image result parts carry original locators, not bytes; provider extras and reasoning never enter saved items. Only the bash result's explicit positive numeric `background_task_id` establishes a start.

Every compaction row becomes a stable summary with complete text, source ID, chat, creation time and `[oldCursorMs,newCursorMs)` coverage. The current archive records neither previous-summary ID nor exact input references; no relationship is invented. Timeline order is `(timeMs, sourceOrder, sourceId, entryIndex, partIndex)`: original message received time/rank 0, TR requested time/rank 1, summary creation time/rank 2. Summary coverage and generation/bootstrap positions remain separate concepts.

The deployed source schema does not persist explicit reply quotes. History retains recorded reply identity and reconstructs creation-time parent snapshots, but cannot recover unrecorded explicit quotes. This feature does not alter the archive to add them.

## Verification and remaining work

`build-input.test.ts` characterizes the production archive input path and one-shot Projection/rendering parity. `bootstrap.test.ts` migrates real disk SQLite files and compares this reference with uninterrupted and every-row-restarted durable builds, different slice sizes, cross-chat/generation isolation, tied times, fences, old edits/deletes/replies/quotes/echoes, user/chat state, revision chains, explicit/ambiguous task starts, all summaries and full FTS/relations. It checks writer failure rollback, repeated commit idempotence, actual process exit inside a writer transaction, resumption without rereading a committed prefix, standalone CLI, byte/output/dependency failures and indexed query plans.

A repeatable scale fixture grows from 300 to 3,000 unique messages/users. A standalone run measured 2 peak dependency lookups for both sizes and 3,252 / 3,305 encoded workspace bytes, with approximately 0.64 / 6.41 seconds of build time. Sampled process RSS was 217,415,680 / 154,173,440 bytes and includes fixture setup, loaded dependencies and allocator/GC effects; it is not the workspace byte limit. These measurements separate dependency residency from SQL page size and total RSS. They are fixture evidence, not production archive benchmarking.

Deferred: generation promotion/cleanup, query authorization/SQL guard, search/thread/context/sql SDK, long-term memory and vector/complex retrieval. Offline bootstrap and online synchronization have separate generations/progress; completing the writer does not complete the deferred retrieval design.

## Online ownership and progress

The child opens the original archive with `readonly: true`. It adds no source fields, tables, indexes, triggers, migration entries or writes. All synchronization data belongs to history.db: `history_source_observations` stores source fingerprints and compact metadata, `history_event_targets` supplies canonical recovery locators, `history_source_scans` stores resumable ID progress, and `history_source_changes` queues locally observed changes. No whole source body/IR is copied into that queue.

Initialization captures per-chat source ID fences, including archive-only and summary-only chats. A bounded primary-key scan seeds private ordering/target indexes. Bootstrap then uses those indexes to select source rows in deterministic order and fetches content by source primary key. Each observation, its queued change and scan checkpoint commit in one history transaction. Bootstrap materialization records its actual source fingerprint alongside output/checkpoints; durable missing-media targets reconcile fills during bootstrap.

After bootstrap, each append poll captures finite upper IDs for events, TRs and compactions and reads only IDs greater than the persisted per-source highwater. Cursors never reset to the origin. The first completed post-bootstrap poll fixes a reconciliation watermark; consuming that fixed observed prefix marks baselineComplete. Backdated inserts and new chats are discovered by ID independently of timeline ordering. Each source row's observation, private indexes, pending media and append cursor commit atomically in history.db. No source-cache table scan occurs.

Production archive edits/deletes, runtime completions, TRs and compactions are appended rows. The existing animation backfill is the specific old-event exception: it fills missing animation hashes in attachments. Discovery persists missing animation event IDs and absent description keys in `history_pending_media`, with a one-time durable reread after registration. Normal completion notifications are published only after existing cache/attachment writes, through the composition-root adapters; core persistence has no History dependency.

`history_build_inputs` durably accepts media locators and recovery requests. The child ACKs only after this insert commits; failed receipt produces no ACK. The asynchronous sender retains/retries the frame without entering the producer's call stack. Inspection then schedules changes through the existing observation/consume-task chain. Scheduling and `scheduled_seq` commit atomically; pending removal commits with completed materialization. Missing targets remain pending and are not polled on a timer. History performs no downloads or model calls.

Startup/reconnect or delivery overflow atomically requests two finite reconciliations: unscheduled pending targets, and all registered cache dependencies including completed keys. Upper/after IDs and upper/after cache keys persist in their respective input rows, one locator per scheduling slice; new registrations receive their own one-time reread. Cache fingerprints that changed schedule indexed fanout; unchanged keys do not rebuild output. Media completed before discovery is read directly; media completed after registration but before notification is recovered from durable pending. Duplicate/late notifications are idempotent and never supply stale payloads to rendering.

Migration `0004_async_media_delivery` replaces the old retry timer fields with pending IDs/scheduled seq and introduces durable build inputs. Existing missing-media targets are copied intact. It changes only history.db and preserves the current generation/Projection identity; no core migration or runtime legacy fallback is added.

Bootstrap keysets, monotone source ID highwaters, local observation/consume seqs, pending media and Driver's compaction cursor have separate meanings. Local seq is observation order, not source transaction order. `logLag=0` means the observed queue is empty; status also exposes `sourceHighwaterIds`, `completedSourcePolls`, `lastSourcePollAtMs`, `pendingMedia`, `buildInputBacklog` and `mediaRecoveryActive`. Completed polls have constant idle source work and process only appended rows. Missing media can remain pending indefinitely if its producer never fills it; baseline readiness does not promise media completeness. Arbitrary old-row/cache rewrites and physical removal are outside the append-plus-missing-media contract and require an explicit rebuild generation, without claiming global mutation detection.

A log entry may fan out to many messages. `history_consume_tasks` stores that work and its keyset progress on disk. Cache dependencies and reverse replies are fetched one locator at a time. Task completion plus its items/relationships/FTS/state/revisions/dependencies commits atomically. The continuous consumeSeq remains at the previous fully completed entry until every task is done, then advances in the final task transaction. Crashes can leave a partially materialized current entry, accurately reported by pendingSeq; reopening resumes its unfinished tasks, with no skipped prefix. Neither transport completion nor durable-receipt ACK advances the materialization cursor. Driver compaction cursor remains a separate per-chat time boundary.

Ordinary append edits load the materialized message node and apply only effective new overwrite events with the common reducer. They preserve origin metadata, deletion state and creation-time reply snapshots. Prefix validity is checked against private indexed fingerprints; backdated insertion or source media fill can invalidate it. Historical recovery selects the origin, required self-send/authoritative echo, latest edit and deletion evidence, and only the direct reply parent's effective state strictly before creation. Intermediate edit bodies are not decoded or counted as resident state. Provenance fingerprints stream through keyset queries and commit atomically with output: valid prefixes append only new revision entries, invalid prefixes replace the fingerprint chain without keeping an in-memory revision array. The sourceRevision algorithm, stored schema and generation identity remain unchanged.

## Child, asynchronous delivery, operational budgets and status

The bot's entire historical retrieval layer is opt-in through the top-level YAML configuration:

```yaml
history:
  enabled: false
```

Omitting the section or `enabled` means false; only actual booleans are accepted. This is global, not a per-chat override, and changing it takes effect after restart. `HISTORY_ACCESS` captures this startup setting in a shared `HistoryAccess` capability. Runtime startup/notifications check it. Future history query workers, SDK/API adapters, tools and their prompt instructions must use that same capability when exposing/constructing services and execute reads through `HistoryAccess.run()`, which rejects disabled calls before any lookup. The existing `read_old_messages` tool is outside this independent layer; its registration and original archive backend are unaffected. They cannot accept an enable flag from the model or environment.

When disabled, worker options/environment overrides are not resolved, no child/restart timer or notification payload is created, and history.db is not opened/created. The core archive continues its existing writes; history leaves no source instrumentation. Existing history progress is retained, and ID discovery and finite pending recovery resume when enabled again. Driver context construction/compaction are separate core functions. Standalone CLI/acceptance commands are explicitly invoked operator workflows, independent of the running bot's feature exposure. This is a feature gate for host-provided history services, not an OS file-access sandbox for general bash tools.

`src/container/registrars/history.ts` registers the supervisor factory. The child owns an independent read-only archive connection and the only history writer. A crash-released SQLite EXCLUSIVE transaction in `history.db.writer-lock` prevents another CLI/worker from writing the same history file; it does not hold a transaction in history.db. The distribution has a separate `history-worker.mjs` entry. History migrations default to the application working directory (`history-drizzle/`); library callers may supply an explicit migration directory. Worker option resolution and spawning are deferred out of the core startup stack; invalid options/spawn failures are logged and retried independently. The supervisor restarts abnormal exits after 5 seconds; startup never waits for an IPC-ready response, bootstrap, reconciliation or ACK.

Pipeline has no History callback and never serializes RC for the worker. `createHistoryDelivery` registers compact completion locators synchronously and defers IPC to a microtask. It retains at most 128 keys/64 KiB of accounted delivery memory, coalesces same-target facts, and has one outstanding receipt frame and one in-progress transport write. A frame is retried once per second after a completed write until durable receipt; a saturated transport cannot accumulate new Node writes. Capacity overflow retains a recovery request until acknowledged, with new overflow during an old ACK requiring another request. Reconnection always requests pending and registered-cache recovery. No large body, Sharp handle or image bytes enter this path.

Append discovery pauses at 256 outstanding observation entries after bootstrap, while durable media input/recovery can still progress. Unobserved rows remain in the core archive. This bounds discovery ahead of a slow/failing materializer; it is not a cap on durable fanout, accepted media tasks or total disk usage. History owns all pressure and publishes errors, while core archive/Driver/media operations continue.

The positive integer source/state/encoded-workspace/output limits apply to every row and targeted recovery. Online uses one task per scheduling step, limited rate and short transactions; fanout remains on disk. Event target lists expand into bounded pages of message/reply tasks with an atomic ordinal cursor, so total delete target count does not consume the resident-state allowance. Oversized log/IR/state retain their pending cursor and publish an error including generation/chat/source/seq. Reply thread depth does not consume that dependency allowance. Automatic workers retry at 5-second intervals with their fixed limits. To recover, stop the owning worker, increase operational limits and restart the **same generation**; do not run a second writer or delete progress. Defaults are 64 MiB source/128 MiB encoded workspace and are tested on the real archive without overrides. They do not imply a 128 MiB RSS limit.

Code supports `CAHCIUA_HISTORY_PATH` and a JSON `CAHCIUA_HISTORY_LIMITS` operational override; no deployment files are changed by this implementation. For an isolated standalone worker:

```sh
pnpm exec tsx src/history/worker.ts --history-worker '{"archivePath":"/tmp/test/archive.db","historyPath":"/tmp/test/history.db","generation":"online-test"}'
pnpm exec tsx src/history/status.ts --history /tmp/test/history.db --generation online-test --chat=-100123
```

Status reads history.db read-only with no query SDK: per-source fences/keysets/scan flags, fixed reconciliation watermark, baselineComplete, continuous/pending local seq, observed queue lag, source ID highwaters, completed append poll/time, pending media, phase, error, processing rate, batch duration, encoded workspace/dependency peaks, RSS, durable input backlog/recovery state and source/history WAL sizes. Supervisor metrics separately expose delivery keys/bytes, receipt state, retries and ACK counts. Watermark/rate/metrics are last-observed samples with updatedAt, not a claim that an offline child is current. Unfiltered status coverage is capped at 256 rows; pass a chat to get its three states.

Shutdown first cancels new post-startup work and ingress retry/commit publication, stops Driver/background producers/Telegram, disables late media persistence, then stops asynchronous delivery and asks the child to finish its current small transaction. After 2 seconds the supervisor kills a stuck child and waits for its exit. It never drains backlog. Saved task/consume/bootstrap progress and history-owned source locators remain recoverable; DB connections close after producers and worker. Tests exercise late transforms/backfills and prevent callbacks writing after shutdown.

The history-owned observation queue is deliberately **not pruned** in this release. Long outages and sustained production grow disk usage. Old generations also remain on disk; promotion/cleanup are future maintenance work. Query authorization, raw SQL guard, query process/SDK, memory, ranking and vectors are not implemented and internal unmasked content is never exposed to model/Telegram by this pipeline.

媒体缓存通知与普通编辑的恢复策略不同：普通编辑复用已物化节点；媒体缓存通知定向重建有效原始内容与回复时快照后重新 hydration，避免已保存的派生描述压过当前缓存选择。原始描述/贴纸字段保持来源语义，无需修改来源库或 History schema。

升级迁移 `0005_refresh_media_descriptions` 不改变表结构。它仅从 History 已有依赖索引为在线 generations 追加每个缓存 key 一条持久 source-change，由既有有界消费链路定向重建历史消息/FTS；覆盖 pending 已清除的旧派生输出，保留 generation、来源游标与已提交消费进度。不扫描原库正文，迁移只执行一次。直接缓存通知即使无 pending 也核对来源变化；pending 是缺失职责，不是通知相关性的判定依据。

Migration `0006_bounded_recovery` adds only History input cache-key cursors and schedules existing online generations for registered-dependency reconciliation. Completed resolver cache overwrites converge through direct notices or startup/reconnect/overflow recovery, without periodic archive-body scans or source schema changes.
