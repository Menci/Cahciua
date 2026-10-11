# Historical archive input

Implemented scope: archive reading and historical item construction. The untracked history-retrieval design drafts describe a larger proposed retrieval system; this implementation does not make those drafts complete.

`src/db/history-archive.ts` owns archive IDs, row fingerprints, per-chat source bounds and keyset reads. `src/history/` owns independent historical Projection state, rendering output ranges, IR expansion, timeline keys and saved-item upserts. It does not depend on online Pipeline, Driver's compaction cursor, model context transforms, Telegram clients or LLM transports.

## Consumer entry

```typescript
import { createHistoryArchive } from '../src/db/history-archive';
import { loadImageAltTextByHash } from '../src/db/persistence';
import { buildHistoryInput } from '../src/history';
import { createCachedAltTextHydrator } from '../src/media/alt-text-cache';

const archive = createHistoryArchive(db);
const bounds = archive.captureBounds(chatId);
const hydrateAltText = createCachedAltTextHydrator({
  lookup: hash => loadImageAltTextByHash(db, hash),
  enabled: () => true, // reuse available cached descriptions, no generation
});
for await (const batch of buildHistoryInput({
  archive, bounds, pageSize: 128, hydrateAltText,
})) {
  await writer.writeBatch(batch);
}
```

The caller owns the DB connection and iterator lifetime. A future separate process can import these TypeScript entry points using the project's TS runtime; this change does not register a worker or add startup/shutdown wiring. Stop consuming or call `iterator.return()` to release builder state. Process chats sequentially to avoid retaining several chats' dependency states simultaneously.

A saved-item writer should atomically upsert `change.item` by its `key` and save `batch.progress` under `(bounds.chatId, progress.source)`. These are host-internal, unmasked build data. Each item contains JSON-safe content, metadata and source locators; no Sharp objects, image bytes, provider extras or reasoning. Optional undefined fields disappear in JSON normally. The archive reader's decoded IR is a transient runtime input and is not the IPC/storage contract.

Emission order is source-processing order (TR, events, compactions), not timeline order. A writer sorts its saved view by `compareHistoryOrder(item.order, ...)`. It must apply every upsert, including completion and media-description updates; an archive fingerprint alone is not a fingerprint of cached display data. This interface does not return or retain a full-history output array.

## Reading bounds and progress

`captureBounds(chatId)` captures each source's maximum row ID in one read transaction. Every page filters both `chat_id` and that source's inclusive ID upper fence, then orders and seeks strictly after `(source time, row ID)`. Events use `received_at`, TR uses `requested_at`, compactions use `created_at`. Page requests require a positive integer limit. Events and compactions have composite chat/time/ID indexes; the existing TR chat/requested index includes the integer primary-key row ID through SQLite's secondary-index ordering.

Equal-time rows survive page boundaries. New rows inserted after capture, including backdated rows, remain outside all pages of this build. The upper fences define source membership; they do **not** freeze mutable attachment backfills or the alt-text cache. Use a stable database copy/read snapshot if content must be frozen during a build. Otherwise rebuild after archival backfills to reconcile their current values. Durable mutation logs/live synchronization are outside this input-path change.

Progress belongs to each chat and each source. `after` is the last consumed `(timeMs, id)`, and `done` marks exhaustion within the captured fence. A page exactly equal to the limit is followed by a possible empty terminal page. Rendering ranges never serve as progress cursors.

The low-level reader accepts a saved keyset for source reading, but `buildHistoryInput` deliberately starts each source at the origin. Restarting the builder from only a page cursor would lose Projection dependencies. Recovery currently means replaying from the origin into the same idempotent writer. A future persisted Projection-state adapter must restore IC, original source locators/revision chains and task associations together before adding resumed construction. Saved progress alone does not authorize skipping history.

## Message state and memory

Historical IC is independent of online residency and compaction windows. All events pass through the same pure reducer, including synthetic self-send/authoritative echo merging. Message nodes, users and chat state remain across pages. Service/runtime nodes are discarded after each event page because they cannot be message/reply dependencies and do not become standalone history items. Deleted messages remain available as dependencies. Replies preserve their sender/content snapshot at creation; later edits/deletes do not rewrite that snapshot.

Each page tracks affected message IDs, including earlier edit/delete targets. The builder supplies only those already-projected nodes and their received-time output range to the common renderer. Thus a timestamp shared by many unrelated messages cannot inflate a page's rendering selection. Renderer cache is released before yielding the batch. The writer sees final per-page upserts at the message's original timeline position.

Input/output collections are page-scoped, with consumer backpressure through the async iterator. A single source row can still contain arbitrarily large text, many tool parts or a delete affecting many messages. The current dependency strategy retains **all message nodes and users in one chat**, original/latest provenance per message, and explicitly identified background starts. Total memory is O(message state + users + background starts + one page's content/affected outputs), not bounded by page size. Projection and changed-node selection still scan IC; this is a correctness-first build input, not a disk-backed dependency store. A disk-backed restore/eviction strategy is deferred and must preserve reply snapshots and late-update semantics.

Rendering exposes `record.transcript` with full body text/XML and full reply text/XML, distinct from the runtime presentation's truncated reply preview and deleted-message tombstone. The archive writer consumes this shared formatter output and the existing structured message/attachment metadata, never IC trees or XML-parsed identity. Images remain descriptions/metadata; an unresolved thumbnail is not copied into saved data. Cached alt-text hydration uses the same cache-only media helper as online runtime and creates no resolver/model calls.

Migration `0033_history_archive_inputs` persists `replyQuoteContent` on future message events, fixing an existing persistence gap exposed by historical replay. Previously unrecorded quotes cannot be reconstructed; normal replies still snapshot their archived target content. The migration also adds indexes for archive keyset ordering. No runtime legacy schema fallback is introduced.

Message keys are `(chatId, messageId)`. `source` locates the first message event; `changedBy` locates the latest consumed message/edit/delete evidence. Persistence supplies SHA-256 fingerprints of complete decoded archive rows; the builder chains fingerprints of contributing events as `sourceRevision`. This is derived archive evidence, never a renderer cache revision or monotonic revision number. Fingerprints can change if mutable rows are rebuilt. Reply metadata identifies the actual target message; no trigger-message/wakeup/TR causality is inferred.

## TR and task expansion

TR entries are decoded with the existing database codec. Each readable assistant output becomes a `model-output`, including outputs containing only calls. Calls become `tool-execution` items, results become `tool-result` items. Original entry/part positions are never renumbered after dropping reasoning. Text groups additionally retain their original nested text index. Full argument strings, readable texts, result strings and follow-up flags survive without model-budget truncation. Image result parts carry their original TR/entry/part locator instead of bytes. Reasoning-only assistant entries expose no saved item.

Call/result association is local to one TR's `callId`. Different TRs may reuse provider call IDs. Missing calls/results and duplicate candidates remain explicit (`missing`/`ambiguous`); ambiguous associations do not fabricate links. Each matched result links to its execution and owning output; an execution lists its matched result key. Stable item keys include chat, TR ID and original positions.

For the current bash contract, a uniquely paired result containing an explicit numeric `background_task_id` registers a start. A runtime completion with the same chat/task ID updates that execution with the full summary, task metadata and an event source locator/fingerprint. Multiple starts for one ID are ambiguous. Other results/arguments and temporal proximity do not establish identity. Unlinked or ambiguous completions produce batch diagnostics, not history items. Probe is never read; service/runtime events are never standalone transcript items.

## Summaries and timeline

Every compaction row becomes its own `summary` item with the full summary, compaction ID, chat ID, `createdAtMs`, and coverage `[oldCursorMs, newCursorMs)`. The source locator permits exact archival expansion; the coverage permits future raw-evidence window queries. The archive does not record a previous-summary ID or precise input-row list, so this layer invents neither inheritance nor evidence-row refs.

The stable order is `(timeMs, sourceOrder, sourceId, entryIndex, partIndex)`: messages use their original `receivedAtMs` with rank 0, TR items use `requestedAtMs` with rank 1, summaries use `created_at` with rank 2. Equal-time messages precede TR. Coverage time is separate from summary creation time. Online merge/model behavior remains unchanged; history does not index the lossy `composeContext` output.

## Verification and remaining integration

`src/history/build-input.test.ts` migrates real SQLite fixtures, uses production persistence, reads real keyset pages and consumes the actual builder with a minimal keyed writer. It covers chat isolation across all sources, tied timestamps and small pages, captured fences, cross-page edit/delete/reply/quote/echo, parity with one-shot Projection/rendering of the original canonical events, original IR positions, repeated/ambiguous call IDs, image-free saved output, complete compactions/coverage, exact task completion and cache-only description reuse. Existing rendering/context tests characterize the unchanged online presentation and visibility conversion.

Still deferred: history.db/FTS5 and saved-item writer persistence, background worker lifecycle, persisted dependency checkpoints, live mutation logs/IPC, query authorization/SQL guards, retrieval SDK and long-term memory. The input path provides the changes and locators those consumers need, without claiming those integrations are implemented.
