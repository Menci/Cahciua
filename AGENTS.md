# Cahciua Agent Guide

Reference for contributors. Improve the architecture when touching it; do not add one-off wiring or compatibility shims.

**Maintenance rule:** update this file whenever a key ownership boundary, invariant, or lifecycle rule changes. Detailed schemas and per-file inventories belong in source or focused design documents.

## System Overview

Cahciua is a Telegram group-chat bot built around the **Deterministic Context Pipeline (DCP)**:

1. **Telegram adaptation** (`src/telegram/adaptation.ts`) converts Telegram events to `CanonicalIMEvent`.
2. **Projection** (`src/projection/`) applies the pure reducer `IC' = reduce(IC, event)`.
3. **Rendering** (`src/rendering/`) selects a caller-supplied chat window before serializing IC nodes to reusable, unmasked records with structured source identity and provider-independent XML.
4. **Driver** (`src/driver/`) derives the model RC view (window and blocked-user policy), merges it with stored turn responses, runs the probe gate and primary tool loop, schedules wake-ups, and compacts context.

LLM calls support `openai-chat`, `anthropic-messages`, and `responses` through direct, non-streaming `fetch`. Provider transports live in `src/llm/`; `src/unified-api/` owns the provider-independent `ConversationEntry[]` representation and wire codecs. Turn responses persist that IR, not provider wire objects.

See `docs/dcp-design.md` for rationale and data flow.

## Technology

Node >=22, TypeScript, pnpm, tdl/libtdjson, better-sqlite3 + Drizzle, Immer, alien-signals, Valibot, `@velin-dev/core`, `@guiiai/logg`, tsyringe (factory registration only), Vitest, sharp, ffmpeg-static, ffprobe-static, and lottie-frame. lottie-frame requires system `libpng-dev` and `librlottie-dev`.

## Commands

`pnpm dev` / `pnpm start` / `pnpm build` / `pnpm typecheck` / `pnpm lint[:fix]` / `pnpm test[:run]` / `pnpm login` / `pnpm db:generate` / `pnpm tdlib:build` / `pnpm tdlib:types`.

## Ownership

```text
src/
├── adaptation/   Canonical event/content types and platform-neutral content helpers
├── projection/   Pure IC reducer
├── rendering/    Consumer-owned IC + output range -> reusable unmasked records and XML
├── unified-api/  Provider-independent LLM conversation IR and codecs
├── llm/          Non-streaming provider transports, request prep, request dumps
├── media/        Thumbnails, frame extraction, alt-text resolvers, media runtime
├── history/      Archive input, bounded resumable bootstrap, history.db state/items/FTS
├── driver/       Scheduling, probe/primary wake-up, runner, tools, compaction
├── telegram/     TDLib clients, manager, adaptation, ingress/egress adapters
├── container/    Typed tsyringe tokens and statically imported registrars
├── startup/      Replay and application lifecycle orchestration
├── db/           Drizzle schema and persistence
├── config/       YAML parsing and resolution
├── pipeline.ts   Per-chat IC/base-rendering residency and cache release
└── index.ts      Thin process entry point
```

Platform types (`Attachment`, `MessageEntity`, etc.) live in `src/telegram/message/types.ts`. Canonical types live in `src/adaptation/types.ts`. Canonical IDs are strings. Imports are relative; no tsconfig aliases.

## Dependency Injection And Lifecycle

The composition root uses tsyringe without decorators or constructor injection. Services remain closure factories. `src/container/index.ts` statically imports every registrar so tsdown can trace the complete graph; filesystem discovery, glob imports, and side-effect registration are forbidden.

Registrars use typed symbol tokens and `instancePerContainerCachingFactory`. Business factories never receive the container. Resource shutdown is owned by startup, because factory providers are not automatically disposed by tsyringe.

Construction order breaks cycles explicitly:

- Telegram clients are created before the media runtime; custom-emoji resolution depends directly on the bot client.
- TelegramManager is created after media resolvers.
- Event producers publish through `DriverInputBus`, not a mutable Driver reference.
- Driver is attached before Telegram start, but the bus buffers the latest base rendering per chat until activation.

Startup order: build container and migrate core DB -> launch independent history child without waiting for readiness -> cold replay -> attach Driver and register live handlers -> start Telegram clients -> activate Driver -> recover background tasks -> seed current base rendering -> run post-startup media backfills.

Shutdown is idempotent: deactivate Driver input and cancel post-startup backfills -> stop Driver -> checkpoint background tasks -> stop ingress commits/retries and Telegram clients -> disable late media persistence -> stop history notifications and allow the child a bounded current-transaction grace period -> close SQLite -> dispose the DI container. Shutdown never drains history backlog; child exit releases its writer lock and saved progress survives.

## Core Invariants

### Purity And Forward Flow

Projection is pure and performs no I/O. Only IM/runtime events enter Projection. Driver owns turn responses. External memory/profile data enters through late-binding prompts, never by mutating IC.

### Dual Timestamps

Every canonical event carries:

- `receivedAtMs`: local ingress time captured before asynchronous transforms; ordering source of truth.
- `timestampSec`: Telegram server time shown to the model.
- `utcOffsetMin`: local offset captured at ingress for rendered timestamps.

DB replay orders by `(received_at, id)`.

### Consistency Above Availability

Enabled media transforms are blocking. A per-chat queue may transform later events speculatively, but only a contiguous ready prefix commits. A failed head retries indefinitely and blocks the session; partially transformed events never enter Adaptation.

### TDLib Resolution

Runtime resolves `vendor/libtdjson.so` first and falls back to `prebuilt-tdlib`. `types/tdlib-types.d.ts` is generated and gitignored. `pnpm tdlib:build` builds TDLib master, applies `scripts/tdlib-patches/*.patch`, and regenerates types. `postinstall` runs `pnpm tdlib:types`.

### Telegram Clients And Ingress

Bot and userbot are both tdl clients. With a configured userbot, it exclusively owns message/edit/delete/typing ingress; otherwise the bot provides limited ingress. Outbound sends always use the bot and wait for TDLib's terminal `updateMessageSendSucceeded`/`updateMessageSendFailed` before returning: TDLib resolves `sendMessage` with a per-dialog yet-unsent id while the upload and server confirmation continue asynchronously, so temp files backing `inputFileLocal` must live until that confirmation and the final server message id is only known there. There is no confirmation timeout — large uploads and FLOOD_WAIT retries keep the message pending for unbounded time while still making progress; pending sends are aborted only on client stop. Downloads prefer userbot and fall back to bot, keyed by `(chatId, messageId)` rather than persisted TDLib-local file IDs.

`TelegramManager` owns clients, the ordered ingress queue, and blocking transforms. Metadata resolution and media work run inside that queue after timestamps are captured. `live-handlers.ts` owns Telegram update side effects. `event-sink.ts` centralizes canonical persistence/publication. Commit and publication phases are idempotent so failures retry without advancing the queue cursor or duplicating events. `driver-hooks.ts` owns send/react/download and synthetic self-events. `post-startup.ts` owns historical media backfills.

Configured chats are the in-memory residency whitelist. Unconfigured chats persist events/messages, then stop before alt-text hydration, Projection, Rendering, Driver, and compaction.

### Spam Moderation

`ban_spammer(message_id, reason)` is chat-scoped and opt-in through `tools.banSpammer: true` (default false). The backend enforces the enabled-chat set. Group policy reaches both probe and primary through chat `systemFiles` alongside identity files. Deployment-local group policies can identify eligible accounts through sufficient conversational history showing exclusively one-off solicitation. Genuine questions, feedback, and ordinary exchanges establish normal participation. For normal members discussing topics outside the bot's permitted scope, the bot remains silent on that topic and leaves member conduct to human administrators. Archived names and messages serve as internal reference examples interpreted in context. The service derives the target from a persisted message author, verifies bot permissions and membership, and authorizes eligible members with fewer than 10 distinct observed message IDs. The archive count retains deleted messages, deduplicates edits, and survives compaction and rejoining; its scope is observed speech history. Eligibility is independent of join age.

Moderation uses the bot account for permanent bans and deletion of known accessible messages permitted within Telegram's 48-hour window. `src/telegram/moderation.ts` checks current state and performs each requested action; `moderation-api.ts` owns TDLib calls; `src/db/moderation.ts` queries the existing event archive. The existing tool call/result history records evidence ID, private reason, target UID, and actual outcomes. Each invocation freshly checks membership, evidence, and message count, then returns deletion results for that invocation. Confirmed removals enter Pipeline as canonical delete events with Driver notification disabled.

After a confirmed ban, the tool result supplies an exact announcement with a `tg://user?id=...` link labeled "spam 账号". Primary calls `send_message` with exactly one argument, `text`, containing that announcement. Names, usernames, profile text, spam content, media, and audit reasoning stay in the private assessment. Partial cleanup receives its own factual announcement. The tool always requires follow-up. The group file directs probe activation for eligible cleanup and its notice, preserving the mandatory-send invariant.

### Synthetic Self-Events

Every successful bot send creates a canonical `isSelfSent=true` event carrying the final server message id, persists it, and publishes it to Pipeline without waking Driver. Userbot echo deduplication matches on that message id and replaces the synthetic payload with authoritative Telegram content while preserving `isSelfSent` and the original local ordering timestamp. This closes the probe race without making final context arrival-order dependent.

### Telegram Markdown

Output flows Markdown -> Telegram-supported HTML. Plain-compatible markup passes through TDLib `parseTextEntities`; table/math markup uses `inputMessageRichMessage`. TDLib remains the canonical entity parser, and entity arrays are never constructed manually.

### IC Mutation

Message edits/deletes mutate the target node in place. Entity metadata changes are append-only system events. Existing messages retain their original sender snapshot.

### RC And Turn Responses

Rendering owns a read-only record contract, distinct from Driver's model context. Records expose explicit metadata (message identity, sender/reply/forward snapshots, edit/delete/self-send state and attachment descriptions), presentation bodies and activation facts. They never expose IC nodes, source trees, thumbnail bytes in metadata, or cache revisions. IC identity and complete-source revision matching are private cache details. Rendering prepares full and blocked XML forms but never chooses policy; only source revisions and display parameters invalidate rendering.

Rendering accepts consumer-owned IC and an explicit inclusive-start/exclusive-end output range on `receivedAtMs`. Window selection precedes XML, metadata, revision and image construction; it does not recover state or discard reply/edit/delete dependencies. Online Pipeline and future historical consumers own separate IC, renderer caches and ranges. A rendering range is not a durable build-progress cursor.

Pipeline passes its per-chat rendering window to that common entry and evicts obsolete cache entries on window changes without rendering or publication. Startup maps the saved compaction cursor to an online window before replay; the Driver adapter requires a resident chat before mapping a completed compaction to that window. Pipeline also filters its stored base-record array to keep the next diff baseline inside residency. Driver retains its own input snapshot until the next event. Cold replay still loads only the active event window; this is not an all-history cache.

Driver owns `RenderedContext` / `RenderedContextSegment` in `context-types.ts`. `selectContextView()` explicitly converts base records before scheduling, probe, primary or compaction, selects the cursor window, and masks blocked senders' bodies/images and mention/reply flags. Base records and model segments have incompatible shapes; neither can be substituted for the other. `read_old_messages` uses the same conversion with current policy and no live cursor. Model segments carry no record metadata. Read-only body arrays and Sharp handles are reused; codecs clone Sharp before request-specific processing. See `docs/rendering-interfaces.md` for the contracts and ownership rationale.

RC uses `receivedAtMs`; turn responses use `requestedAtMs`. Equal timestamps order RC before TR for Anthropic role alternation. Stored TRs contain `ConversationEntry[]`, token totals, cache components, and model identity.

The runner performs model-call retries for ignored forced tool choices, aggregates retry usage, and executes/persists only the selected/final response. A completed step is persisted before `checkInterrupt`; interruption is cooperative at step boundaries, never preemptive during model/tool/persistence work.

`send_message.still_working=true` keeps the tool loop open. Without it, `send_message` is terminal unless another parallel tool result requires follow-up.

### Historical Input And Online Synchronization

Synchronization invariant: the entire core archive/realtime/Driver/media path never waits for History readiness, durable enqueue, ACK, rendering or catch-up. History construction/rendering work must not be discarded. Reliable source tasks, media dependencies, asynchronous receipt/retry/recovery and backpressure belong to History and history.db. Pipeline has no History rendering callback. See [the sync design](docs/history-sync-design.md). Do not introduce History ACK waits into ingress or media completion.

The top-level YAML `history.enabled` switch controls the planned independent historical retrieval layer and defaults to false. It is captured at startup, with no per-chat override or environment-based enablement. `HISTORY_ACCESS` owns the shared capability: worker startup/notifications check `enabled`; future query workers, SDK/API adapters, tools and their prompt instructions must use the same capability at construction/exposure and execute reads through `HistoryAccess.run()`, never accept an agent-provided enable flag. The existing `read_old_messages` tool is outside this layer: its registration and archive backend remain independent of the switch. Disabled history resolves no worker options, spawns no child, sends no notifications and creates no history database. Core archive persistence and Driver compaction continue so re-enabling can resume durable catch-up. Changing the switch requires restarting the bot. Standalone operator maintenance/acceptance commands remain explicitly invoked independently of bot startup.

`src/db/history-archive.ts` provides read-only source fences, byte preflight, exact reads and fingerprints against the existing core archive schema. History adds no fields, tables, indexes, triggers, synchronization writes or migrations to the source database. Explicit Telegram reply quotes are not persisted by this source schema; historical reconstruction preserves observed direct reply content without inventing missing quotes. Any future core archive fidelity change requires its own scope and migration.

`src/history/` owns the unique history.db writer child, read-only source connection, private source fingerprints/ordering/target indexes, durable per-source ID highwaters, local observation queue, pending-media targets, saved items/FTS and sparse Projection state. Initial paged discovery builds private indexes before fenced per-chat bootstrap. The first post-bootstrap append poll fixes a reconciliation watermark. Subsequent polls read only IDs above persisted highwaters; normal edits/deletes, TRs and compactions are append-only. No periodic full archive/cache rescan exists.

The existing post-startup animation backfill can fill a missing hash in an old event's attachments. Discovery persists missing event IDs/cache keys and a one-time reread after registration. Composition-root adapters publish media completion only after existing core writes; the asynchronous sender never waits in the producer's stack. The child ACKs durable `history_build_inputs` receipt before inspecting dependencies or rendering. Scheduling and pending `scheduled_seq` commit atomically; pending removal commits with completed output. Normal operation has no pending timer polling. Startup/reconnect/overflow requests bounded pending reconciliation with a persistent finite cursor. Capacity overflow retains a recovery request; disconnect/restart always re-establishes it. Cache overwrites, arbitrary old-row edits and physical deletion still require an explicit new generation.

Ordinary History edits reuse materialized message state and apply effective append overrides through the common reducer; edit count is not a resident-state budget. Backdated/source-fill recovery selects only effective event bodies, preserving original metadata, deletion and direct reply snapshots at creation. Provenance fingerprints remain streaming metadata in History and commit with output; no full edit-body replay or resident revision-chain array is required.

Fingerprints, locator changes, observation queue entries, pending targets and ID progress commit atomically in history.db. Each fanout task commits output/state/dependencies with task progress; consume seq advances only when that observation's tasks all complete. No cross-database atomicity is claimed. Local observation seq is discovery order, not source transaction order. Zero queue lag alone does not prove source freshness; status reports sourceHighwaterIds, completedSourcePolls, lastSourcePollAtMs and pendingMedia. Version 3 uses a distinct generation identity; incompatible resumes fail without legacy fallback.

The main process never waits for history readiness/bootstrap/catch-up/ACK. Worker option resolution/spawn are deferred out of the core startup stack; their failures log and retry independently. Nonresident/archive-only/new chats are independently observed without changing Pipeline residency. The delivery adapter bounds registered keys/bytes and outstanding transport writes; it retries durable receipt in the background. After bootstrap, append discovery pauses at 256 outstanding observed entries, retaining unread sources in the archive; accepted media/recovery tasks remain durable. Shutdown stops producers/backfills and late callbacks before stopping delivery and the child; it does not drain backlog. History-only migration 0004 preserves existing pending targets and generation identities. Query worker/SDK, SQL guard and memory remain deferred.

Media cache notifications rebuild only the affected messages from effective raw canonical sources before hydration. Persisted node descriptions are derived output, never authority for cache refresh; fresh cache precedence applies to attachments and reply-at-creation emoji content while source-provided fields survive. Ordinary edits continue to reuse the materialized prefix. Direct cache notifications are inspected even without a pending row; pending tracks missing-source obligations. History-only data migrations can enqueue indexed media targets for bounded repair without resetting generations or touching the source archive.

### Mandatory Probe Gate

Every wake-up runs an outside-judge probe before primary except continuation of an interrupted tool loop. Mentions, direct replies, and runtime events still run probe.

Probe receives only `decide(should_act, reason)`. `should_act` is `send_message` or `no_action`. Missing/malformed decisions fail closed. Probe output is persisted in `probe_responses_v2` and never enters primary context.

An activated primary must issue at least one `send_message` during the wake-up. It may chain tools first. If a clean `end_turn` closes a loop without any send, Driver runs one forced `send_message` fallback. There is no silence tool.

### Scheduling

Each chat owns an alien-signals scheduler. The trigger sender's later messages extend the initial delay; other senders do not. Typing extends the delay. `maxDelayMs` caps the window. Calls are serialized. New input during a tool loop is observed only after the current step is persisted.

### Compaction

Compaction is an independent per-chat controller, not a turn feature or TR. Raw RC + TR content after the cursor, excluding the existing summary, triggers at `maxContextEstTokens`. The retained window targets `workingWindowEstTokens`. Summaries are append-only rows in `compactions`; after persistence, updating metadata advances the pure Driver view and releases expired Pipeline rendering cache entries. The cursor effect never writes the base input signal or republishes message bodies.

### Provider Boundaries

`src/llm/call.ts` is the common non-streaming call boundary. It enforces `maxImagesAllowed` on every request, converts IR through `src/unified-api/`, normalizes usage, and writes debug request/response JSON under `/tmp/cahciua/`.

Reasoning survives replay only when the stored model identity is compatible. Tool call IDs remain provider-native in storage and are sanitized only for wire formats that require it.

Token semantics are uniform:

- `inputTokens` is total billable input, including Anthropic cache reads/writes.
- `cacheReadTokens` is the cached-input component.
- `cacheWriteTokens` is Anthropic cache creation; other formats report zero.

### Media

`src/media/` owns all provider/platform-neutral processing. Telegram only supplies bytes and metadata.

- Passive image alt text: thumbnail WebP hash is the cache key; model input is PNG <=512px. Explicit `read_image(detail="high")` may use 1024px.
- Animations/stickers: file SHA-256 is the key; frames are count-based/equidistant; gzip magic identifies TGS; files over 20 MB fail.
- Custom emoji: cache key is `emoji:<id>`; the bot client supplies media bytes.

Alt text is read transiently from `image_alt_texts` and is not persisted in event JSON. Resolver model, concurrency, and frame limits are selected per chat; cache records remain content-addressed and shared. Content-aware frame selection remains deferred in `docs/content-aware-frame-selection.md`.

### Security And Diagnostics

Identity is encoded in XML attributes, never user-controlled inline labels. `registerHttpSecret()` redacts credentials in HTTP errors. Full request dumps under `/tmp/cahciua/` are intentional for this research deployment.

## Conventions

- Functional factories, `const`, arrow functions. Classes only for library contracts or Error subclasses.
- Strict types; avoid `any`; use `unknown` and narrowing. `import type` is enforced.
- Kebab-case files, relative imports, current ES syntax.
- `@guiiai/logg` only; `console.log` is for CLI copy-paste output.
- Comments record non-obvious decisions, constraints, and evidence. Do not narrate code.
- Let errors propagate. Do not silently catch or invent defaults for invalid data.
- Style: 2 spaces, single quotes, semicolons, multiline trailing commas, 1TBS, LF.

## Testing And Dependencies

Vitest tests live next to source as `*.test.ts`. Add regression tests for bugs and characterization tests before behavior-preserving structural changes. Driver, startup/DI, persistence, and Telegram integration are high-risk boundaries.

Use `pnpm add [-D]`; never hand-edit dependency manifests. Finish with `pnpm typecheck`, `pnpm lint:fix`, `pnpm test:run`, and `pnpm build`.

Generated/local directories (`data/`, `.tdlib-build/`, `types/`, `dist/`) are excluded from lint.

## Data Migration

Code handles only the current data shape. Existing data changes require a new Drizzle migration; never add runtime legacy fallbacks.

## Commits

Conventional Commits. Keep changes focused and update architectural docs in the same commit. **Never commit or push without explicit human instruction.**

## Downstream Backports

The downstream remote is `chiyuki0325/Edelweiss` (`edelweiss`).

- Faithful port: original human author, Menci as human co-author, preserve upstream author date, include the full source SHA.
- Reimplementation: Menci author, original human author as co-author, explain that the concept came from Edelweiss.
- Original local fix: Menci author, no downstream co-author.
- Strip every AI co-author trailer; keep human attribution.

Do not port downstream persona content, infrastructure-specific debugging, streaming transports, OneBot code, probe removal, preemptive abort scheduling, or features already present here. Resolve conflicts in a worktree, verify all checks, and never sweep unrelated changes into a commit.
