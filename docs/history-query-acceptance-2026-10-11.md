# History query acceptance — 2026-10-11

This change completes phase 4 over `codex/history-online` at `005ff4ae7d0378777f5626b991d1c0b9422002aa`, plus disposable CodeAct execution, Driver integration and shutdown. It preserves the existing writer, archive schema, Probe gate and read_old_messages backend. New compaction provenance and memory are deferred. Related issue: [tommy0103/Cahciua#10](https://github.com/tommy0103/Cahciua/issues/10).

## Executed checks

Checks ran in a newly created, network-disabled Docker container using the existing `cahciua-local:tdlib-1.8.67-node22` image, one CPU and 1,536 MiB container memory. Source data was mounted read-only, then copied with SQLite's online backup API into a new directory. All fixture writes and history migrations targeted that copy. No production service, config, environment, compose file, Dockerfile or original archive schema was changed.

Runtime was Node 22.23.3, SQLite 3.49.2, sqlite3-parser 0.7.1 (exact dependency), QuickJS 0.32.0. Existing Linux native dependencies were reused; newly copied dependencies are JS/WASM. Mac copy metadata was removed from this disposable container before final checks.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| `pnpm lint:fix` | Passed |
| `pnpm test:run` | 56 files, 584 tests passed; final rerun 85.55 seconds |
| `pnpm build` | Passed; index, history-worker and history-query-worker distribution entries |
| `pnpm test:run -- src/history/query/query.test.ts src/driver/prompt.test.ts` | 584 tests passed again, including executable SDK examples and prompt exposure |
| `node --import tsx docs/history-query-evidence/acceptance.mjs --archive /source/cahciua.db --out /tmp/query-delivery-evidence` | Passed using compiled builder and query workers |

The host additionally ran typecheck/lint and actual query/Driver tests under Node 24 to match its existing better-sqlite3 binary. Docker supplies the full native integration evidence.

## Real archive evidence

Machine-readable [real-archive.json](history-query-evidence/real-archive.json) contains only counts, statuses, timings and hashes. [acceptance.mjs](history-query-evidence/acceptance.mjs) reproduces the backup, default-budget build, reference comparison, SDK/SQL checks and concurrency tests. It refuses to reuse an output directory and closes all children/connections.

The frozen source backup had 1,408 events, 310 TRs and one compaction across four chats. A controlled summary was added only to the copy to test summary navigation. The compiled writer produced 2,189 items, with zero differences against the independent one-shot archive/Projection/rendering reference. The reference intentionally retains full chat state as an acceptance oracle; the query process does not.

The selected current-chat public view contained 764 messages, 292 readable outputs, 381 calls, 381 results and two summaries before concurrent fixture writes. All four helpers executed through actual QuickJS → host bridge → scoped SQLite. Counts and FTS ref/snippet/rank results agreed exactly with host SQL. Summary search expanded its covered window and continuation filter; tool/output/execution joins succeeded. Eight real-container SQL attacks were rejected. A newly rebound blocked-user policy produced zero visible messages for that sender.

The combined SDK/SQL request took 650.63 ms with default query budgets. During a three-second query, the writer committed a new record; the script's two counts stayed equal and its search saw no new hit. The next script saw the hit. A separate unbounded native recursive SQL query hit a 1,500 ms parent deadline in 1,504.94 ms while the builder continued materializing another message. After query and builder shutdown, TRUNCATE checkpoint returned `{busy:0,log:0,checkpointed:0}` and integrity_check returned `ok`. Original schema hashes before/after were identical; original files were accessible only read-only.

An initial real run exposed repeated policy and JSON evaluation inside joins and reached the unchanged 10-second deadline. The final implementation evaluates policy once, retains authorized IDs and indexes authorized public JSON in SQLite's file-backed TEMP store. It does not load an unmasked chat array into Node memory, rewrite model SQL, add LIMIT or weaken query scope.

## Regression coverage

- Literal Unicode/trigram and one/two-character substring search, escaped `%`/`_`, summaries included by default, and all prompt examples run as actual scripts.
- Stable assembly-unit pagination, only-tool outputs, multiple calls, matched/missing results, explicit send links and self-send collapse, context neighbors excluding their own assembly, and full Unicode code-point windows.
- Native FTS handles/aliases/rank/snippet, JOINs, recursive CTEs, lexical CTE shadowing, quoted identifiers, bound injection values, JSON/json_each/json_tree, aggregates and window expressions.
- Private tables, main/schema/shadow objects, nested expression and UNION/CTE attacks, IN-table syntax, pragma functions, writes, multiple statements, readfile and load_extension denied across the whole AST.
- Blocked/deleted exact refs, reply snapshots, nested tool arguments/results, JSON/FTS/count/relations and whole-TR withholding. Ten-thousand-level JSON nesting checks known blocked identity without recursion overflow or a swallowed traversal error.
- Source revision changes, source byte preflight, current-chat coverage and observed lag, unrelated shared-cache dependencies excluded, foreign refs, incomplete membership and absent index.
- QuickJS host globals/constructor access, loops, interpreter allocation, native SQLite heap quota, SQL/code/row/cumulative/final byte budgets, caught-budget failure and execution-bound cursors.
- Real child → Driver tool → runner → SQLite TR persistence → follow-up send; input events unchanged. Feature-enabled tool/prompt binding, feature-disabled legacy backend and Probe prompt unchanged.
- Same-chat serialization, changed policy on the next child, active/queued cancellation, writer progress during a pinned read snapshot and native SQL, process closure and snapshot/checkpoint release.

## Limits retained in the contract

The query reads the last committed index and reports coverage/observed lag; it does not wait for fresh results. Explicit event evidence uses a separately verified source read, not a cross-database atomic transaction. FTS rank uses global corpus statistics while rows/snippets/counts stay scoped. Policy conservatively withholds containing rows/whole TRs for known identity and exact copied hidden content; arbitrary paraphrases have no recorded provenance. Missing summary source/parent refs remain empty/NULL. Offline generations need a new build for metadata never stored; online migration refreshes it through the existing bounded consumer. The FTS migration rebuild can take time on a large index. Allocator quotas do not promise a total RSS ceiling.

No deployment, production enablement, merge or unrelated worktree change is part of this delivery.
