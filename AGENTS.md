# Cahciua Agent Guide

Reference for contributors. Improve the architecture when touching it; do not add one-off wiring or compatibility shims.

**Maintenance rule:** update this file whenever a key ownership boundary, invariant, or lifecycle rule changes. Detailed schemas and per-file inventories belong in source or focused design documents.

## System Overview

Cahciua is a Telegram group-chat bot built around the **Deterministic Context Pipeline (DCP)**:

1. **Telegram adaptation** (`src/telegram/adaptation.ts`) converts Telegram events to `CanonicalIMEvent`.
2. **Projection** (`src/projection/`) applies the pure reducer `IC' = reduce(IC, event)`.
3. **Rendering** (`src/rendering/`) serializes IC to provider-independent XML segments (`RC`).
4. **Driver** (`src/driver/`) merges RC with stored turn responses, runs the probe gate and primary tool loop, schedules wake-ups, and compacts context.

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
├── rendering/    IC -> XML RenderedContext
├── unified-api/  Provider-independent LLM conversation IR and codecs
├── llm/          Non-streaming provider transports, request prep, request dumps
├── media/        Thumbnails, frame extraction, alt-text resolvers, media runtime
├── driver/       Scheduling, probe/primary wake-up, runner, tools, compaction
├── telegram/     TDLib clients, manager, adaptation, ingress/egress adapters
├── container/    Typed tsyringe tokens and statically imported registrars
├── startup/      Replay and application lifecycle orchestration
├── db/           Drizzle schema and persistence
├── config/       YAML parsing and resolution
├── pipeline.ts   Per-chat IC/RC residency
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
- Driver is attached before Telegram start, but the bus buffers the latest RC per chat until activation.

Startup order: build container and migrate DB -> cold replay -> attach Driver and register live handlers -> start Telegram clients -> activate Driver -> recover background tasks -> seed current RC -> run post-startup media backfills.

Shutdown is idempotent: deactivate Driver input -> stop Driver -> checkpoint background tasks -> stop Telegram clients -> close SQLite -> dispose the DI container.

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

Bot and userbot are both tdl clients. With a configured userbot, it exclusively owns message/edit/delete/typing ingress; otherwise the bot provides limited ingress. Outbound sends always use the bot. Downloads prefer userbot and fall back to bot, keyed by `(chatId, messageId)` rather than persisted TDLib-local file IDs.

`TelegramManager` owns clients, the ordered ingress queue, and blocking transforms. Metadata resolution and media work run inside that queue after timestamps are captured. `live-handlers.ts` owns Telegram update side effects. `event-sink.ts` centralizes canonical persistence/publication. Commit and publication phases are idempotent so failures retry without advancing the queue cursor or duplicating events. `driver-hooks.ts` owns send/react/download and synthetic self-events. `post-startup.ts` owns historical media backfills.

Configured chats are the in-memory residency whitelist. Unconfigured chats persist events/messages, then stop before alt-text hydration, Projection, Rendering, Driver, and compaction.

### Synthetic Self-Events

Every successful bot send immediately creates a canonical `isSelfSent=true` event, persists it, and publishes it to Pipeline without waking Driver. Userbot echo deduplication replaces the synthetic payload with authoritative Telegram content while preserving `isSelfSent` and the original local ordering timestamp. This closes the probe race without making final context arrival-order dependent.

### Telegram Markdown

Output flows Markdown -> Telegram-supported HTML. Plain-compatible markup passes through TDLib `parseTextEntities`; table/math markup uses `inputMessageRichMessage`. TDLib remains the canonical entity parser, and entity arrays are never constructed manually.

### IC Mutation

Message edits/deletes mutate the target node in place. Entity metadata changes are append-only system events. Existing messages retain their original sender snapshot.

### RC And Turn Responses

RC uses `receivedAtMs`; turn responses use `requestedAtMs`. Equal timestamps order RC before TR for Anthropic role alternation. Stored TRs contain `ConversationEntry[]`, token totals, cache components, and model identity.

The runner performs model-call retries for ignored forced tool choices, aggregates retry usage, and executes/persists only the selected/final response. A completed step is persisted before `checkInterrupt`; interruption is cooperative at step boundaries, never preemptive during model/tool/persistence work.

`send_message.still_working=true` keeps the tool loop open. Without it, `send_message` is terminal unless another parallel tool result requires follow-up.

### Mandatory Probe Gate

Every wake-up runs an outside-judge probe before primary except continuation of an interrupted tool loop. Mentions, direct replies, and runtime events still run probe.

Probe receives only `decide(should_act, reason)`. `should_act` is `send_message` or `no_action`. Missing/malformed decisions fail closed. Probe output is persisted in `probe_responses_v2` and never enters primary context.

An activated primary must issue at least one `send_message` during the wake-up. It may chain tools first. If a clean `end_turn` closes a loop without any send, Driver runs one forced `send_message` fallback. There is no silence tool.

### Scheduling

Each chat owns an alien-signals scheduler. The trigger sender's later messages extend the initial delay; other senders do not. Typing extends the delay. `maxDelayMs` caps the window. Calls are serialized. New input during a tool loop is observed only after the current step is persisted.

### Compaction

Compaction is an independent per-chat controller, not a turn feature or TR. Raw RC + TR content after the cursor, excluding the existing summary, triggers at `maxContextEstTokens`. The retained window targets `workingWindowEstTokens`. Summaries are append-only rows in `compactions`; updating the signal applies the new Pipeline cursor.

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
