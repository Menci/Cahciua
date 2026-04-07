# Cahciua Agent Guide

Reference for contributors working on the Cahciua codebase. Improve code when you touch it; avoid one-off patterns.

**Maintenance rule**: When you add, rename, or remove a file, change a key pattern, or complete a milestone — update this file in the same commit. Outdated docs are worse than no docs.

## What Is Cahciua

Cahciua is a Telegram group chat bot built on the **Deterministic Context Pipeline (DCP)** architecture. DCP constructs LLM context through a three-layer pure-function pipeline:

1. **Adaptation**: Platform Event → CanonicalIMEvent (anti-corruption layer).
2. **Projection**: `IC' = Reducers(IC, CanonicalIMEvent)` — pure-function state machine producing an Intermediate Context (IC).
3. **Rendering**: `RC = Render(IC, RenderParams)` — serialization with viewport filtering, producing Rendered Context (RC).

The Driver layer sits after Rendering: it merges RC (chat context) with its own TRs (bot responses, tool results) by timestamp to assemble the final LLM API request. Driver owns tool call loops, reactive scheduling, and context compaction. Supports two API formats: OpenAI Chat Completions (`openai-chat`, via xsai with SSE streaming) and OpenAI Responses API (`responses`, via direct fetch with SSE streaming). TRs are stored in raw provider format; conversion happens at API boundaries when composing context or sending requests.

Key design goals: KV Cache friendly (append-only history, static system prompt, epoch-based compaction), group chat native (message batching, multi-user identity tracking, anti-injection via XML fencing), autonomous reply (bot decides whether to respond via Tool Call, not synchronous response).

## Current Progress

| Layer | Status | Notes |
|-------|--------|-------|
| Telegram integration | Done | Bot + userbot, dedup, fileId merge, credential redaction, per-session ingress queue, blocking image-to-text, blocking animation-to-text |
| Adaptation | Done | Types, conversion, dual timestamps, rich text parsing, string IDs, phantom edit filtering |
| DB / Persistence | Done | events, messages, turn_responses, compactions, probe_responses, image_alt_texts tables; 21 migrations |
| Projection | Done | Reducer (message/edit/delete), MetaReducer (user rename detection), Immer-based immutability |
| Rendering | Done | `render(IC, RenderParams) → RC`, XML serialization, viewport filtering, thumbnail content pieces, inline `<image>` / `<animation>` alt text rendering |
| Driver | Done | Dual-provider SSE streaming (OpenAI Chat Completions via xsai + Responses API via fetch), manual tool execution, per-step TR persistence, mid-turn interruption, reasoning sanitization (per-provider format), reactive orchestration (alien-signals), context compaction (LLM-based summarization with append-only history), probe/activate gate (small model decides silence vs activation), format conversion (openai-chat ↔ responses) at API boundaries |

## Tech Stack

- **Runtime**: Node.js (>=22), TypeScript, tsx (dev), tsdown (build).
- **Telegram Bot API**: grammY — primary message handling, sending replies, commands.
- **Telegram User API**: gramjs (`telegram` on npm) — MTProto client for history fetching, reply-to context resolution, seeing other bots' messages.
- **LLM**: Two API format paths — OpenAI Chat Completions (via xsAI `chat()` with `stream: true`) and OpenAI Responses API (via direct `fetch` with SSE streaming). Context composition always outputs openai-chat format as lingua franca; conversion to responses format happens at the runner layer. SSE streaming helpers in `src/driver/streaming.ts` (chat) and `src/driver/streaming-responses.ts` (responses) parse chunks and log deltas in real time.
- **Image processing**: sharp — thumbnails, GIF frame extraction, image resizing.
- **Animation processing**: ffmpeg-static + ffprobe-static (bundled binaries via npm) — MP4/WEBM frame extraction; lottie-frame (native rlottie + libpng addon) — TGS/Lottie frame rendering. System deps: `libpng-dev`, `librlottie-dev`.
- **Database**: SQLite via better-sqlite3, Drizzle ORM.
- **State management**: Immer — immutable IC updates in Projection reducers.
- **Reactivity**: alien-signals — signal/computed/effect graph for Driver orchestration.
- **Validation**: Valibot — schema validation for config and other runtime inputs where schemas are defined.
- **Prompts**: @velin-dev/core — all LLM prompts are velin templates (`.velin.md`) in the `prompts/` directory, rendered via `renderMarkdownString`. Never hardcode prompt strings in source code.
- **Logging**: @guiiai/logg — structured logger with pretty/JSON output.
- **Testing**: Vitest.
- **Linting**: ESLint with `@typescript-eslint`, `@stylistic/eslint-plugin`, `eslint-plugin-import`.
- **Package manager**: pnpm (hoisted `node_modules` via `.npmrc`).

## Project Structure

```
src/
├── index.ts                # Entry point — thin wiring shell (config, DB, telegram, pipeline, driver)
├── pipeline.ts             # Per-chat IC/RC state manager (reduce → render → log → dump)
├── http.ts                 # HTTP client with credential redaction (registerHttpSecret)
├── config/
│   ├── config.ts           # Unified YAML config loader (Valibot schema)
│   └── logger.ts           # @guiiai/logg setup (pretty in dev, JSON in prod)
├── adaptation/             # Layer 1: Platform Event → Canonical Event
│   ├── types.ts            # CanonicalIMEvent, CanonicalUser, ContentNode, etc.
│   ├── index.ts            # adaptMessage, adaptEdit, adaptDelete, parseContent, contentToPlainText + re-exports
│   └── index.test.ts       # Adaptation unit tests
├── projection/             # Layer 2: IC' = Reducers(IC, Event)
│   ├── types.ts            # IntermediateContext, ICMessage, ICSystemEvent, ICUserState
│   ├── reduce.ts           # reduce(IC, CanonicalIMEvent) → IC' with Immer
│   ├── reduce.test.ts      # Reducer unit tests
│   └── index.ts            # Barrel exports
├── rendering/              # Layer 3: IC + RenderParams → RenderedContext (RC)
│   ├── types.ts            # RenderParams, RenderedContentPiece, RenderedContextSegment, RenderedContext
│   ├── index.ts            # render(), rcToXml(), XML serialization of ContentNode/attachments
│   └── index.test.ts       # Rendering unit tests
├── driver/                 # Driver: RC + TRs → LLM API calls
│   ├── types.ts            # TurnResponse, DriverConfig, ProviderFormat, ContextChunk, CompactionSessionMeta
│   ├── context.ts          # Pure functions: context composition, token trimming, reasoning sanitization, working window cursor
│   ├── context.test.ts     # Context composition tests (openai-chat + responses provider branches)
│   ├── merge.ts            # mergeContext(RC, TRs) → ContextChunk[] — timestamp-ordered interleave
│   ├── merge.test.ts       # Merge logic tests
│   ├── convert.ts          # Format conversion: openai-chat ↔ responses (chatTRToResponsesInput, responsesOutputToMessages, messagesToResponsesInput, xsaiToolToResponsesTool)
│   ├── convert.test.ts     # Conversion + round-trip fidelity tests
│   ├── constants.ts        # Driver-scoped constants and dump-dir bootstrap helpers
│   ├── responses-types.ts  # OpenAI Responses API type definitions (request/response/stream events)
│   ├── sse.ts              # Shared SSE line-buffer parser used by both provider streamers
│   ├── runner.ts           # LLM step loop: dual-provider SSE streaming + manual tool execution
│   ├── streaming.ts        # SSE streaming chat: parses OpenAI-compat SSE into ChatCompletion result with per-chunk logging
│   ├── streaming-responses.ts # SSE streaming responses: parses Responses API SSE into output items with per-chunk logging
│   ├── compaction.ts       # Context compaction: LLM-based conversation summarization (dual-provider)
│   ├── prompt.ts           # Prompt rendering — loads all velin templates from prompts/
│   ├── system-prompt.test.ts # System prompt tests
│   ├── tools.ts            # send_message tool definition (xsai Tool)
│   └── index.ts            # createDriver() — reactive orchestration (alien-signals)
├── db/
│   ├── client.ts           # Database init (better-sqlite3 + Drizzle), WAL mode
│   ├── schema.ts           # Drizzle schema: users, messages, events, turnResponses, compactions, probeResponses, imageAltTexts tables
│   ├── persistence.ts      # CRUD: persistEvent, persistMessage, persistTurnResponse, persistCompaction, image alt text cache lookups, loadEvents, loadTurnResponses, loadCompaction, etc.
│   └── index.ts            # Barrel exports
└── telegram/
    ├── index.ts             # TelegramManager — unified facade, session ingress queue, blocking media transforms, dedup dispatch
    ├── bot.ts               # grammY Bot API client
    ├── userbot.ts           # gramjs MTProto client
    ├── event-bus.ts         # Simple typed pub/sub
    ├── image-to-text.ts     # Blocking image→alt text workflow + cache lookup/persist + model calls
    ├── image-to-text-prompt.ts # Velin prompt renderer for image description workflow
    ├── animation-to-text.ts   # Blocking animation→alt text workflow (GIF, animated/video stickers)
    ├── animation-to-text-prompt.ts # Velin prompt renderer for animation description workflow
    ├── frame-extractor.ts     # Frame extraction from animations (MP4/WEBM via ffmpeg, GIF via sharp, TGS via lottie-frame)
    ├── llm-description.ts     # Shared utilities for image/animation description LLM calls (semaphore, streaming helpers)
    ├── session-ingress-queue.ts # Per-chat ordered commit queue with speculative async transforms
    ├── thumbnail.ts         # sharp-based thumbnail generation (pixel-budget ≤75k pixels ≈ 100 Claude tokens)
    ├── gramjs-logger.ts     # Patches gramjs internal logger to @guiiai/logg
    ├── markdown.ts          # Markdown → Telegram HTML converter (MarkdownIt-based)
    ├── session.ts           # Session file load/save
    ├── login.ts             # Interactive MTProto login script (pnpm login)
    └── message/
        ├── types.ts         # TelegramUser, TelegramMessage, Attachment, ForwardInfo, MessageEntity
        ├── gramjs.ts        # gramjs Api.Message → TelegramMessage conversion
        ├── gramjs.test.ts   # GramJS message conversion + merge regression tests
        ├── grammy.ts        # grammY Message → TelegramMessage conversion
        ├── dedup.ts         # Set-based message dedup with LRU eviction (10k)
        └── index.ts         # Barrel exports
```

Top-level directories:
- `prompts/` — all LLM prompt templates (velin `.velin.md` files), rendered at runtime via `@velin-dev/core`
  - `primary-system.velin.md` — main system prompt for chat LLM calls
  - `primary-late-binding.velin.md` — context-aware injection (probe/mention/reply state)
  - `compaction-system.velin.md` — compaction LLM system prompt
  - `compaction-late-binding.velin.md` — compaction LLM user instruction (output format)
  - `image-to-text-system.velin.md` — blocking image description prompt used before events enter the pipeline
  - `animation-to-text-system.velin.md` — blocking GIF/animation description prompt (multi-frame)
  - `sticker-animation-to-text-system.velin.md` — blocking animated sticker description prompt (multi-frame)
- `docs/` — architecture and design documents (not prompts)
  - `dcp-design.md` — architecture rationale and Driver/TR design
- `dcp-updates.md` — implementation deltas from the original RFC

### Type Ownership

Platform types (`Attachment`, `ForwardInfo`, `MessageEntity`) are defined in `telegram/message/types.ts` — they belong to the telegram layer. `db/schema.ts` imports them for JSON column annotations. Never define platform types in the DB layer.

Canonical types (`CanonicalIMEvent`, `CanonicalUser`, `ContentNode`, etc.) are defined in `adaptation/types.ts`. `ContentNode` is the platform-agnostic rich text representation — Adaptation parses platform-specific encodings (e.g. Telegram's text + offset-based entities) into `ContentNode[]` trees. All IDs in canonical types are strings (platform-agnostic).

### Imports

Use relative paths for all internal imports:
```ts
import { loadConfig } from './config/config';
import type { CanonicalIMEvent } from '../adaptation/types';
```

## Commands

- `pnpm dev` — run with file watching (tsx watch).
- `pnpm start` — run once (tsx).
- `pnpm build` — bundle with tsdown.
- `pnpm typecheck` — `tsc --noEmit` (current `tsconfig.json` only includes `src/**/*.ts`).
- `pnpm lint` / `pnpm lint:fix` — ESLint.
- `pnpm test` / `pnpm test:run` — Vitest.
- `pnpm login` — interactive MTProto session login.
- `pnpm db:generate` — generate Drizzle migration from schema changes.

## Architecture Rules

### DCP Layers Are Pure Functions

Projection reducers must be pure: `(IC, CanonicalIMEvent) => IC'`. No I/O, no side effects, no network calls. Projection only processes IM platform events — bot's own LLM interactions live exclusively in the Driver layer (unidirectional data flow, no backflow). External data (memory, user profiles) enters either through Driver-level late binding (current implementation) or as pre-fetched fields on the event.

### Dual Timestamps

Every `CanonicalIMEvent` carries two timestamps:
- `receivedAtMs` (milliseconds): local receive time, captured at telegram ingress **before** any asynchronous media transforms or queue blocking. **Ordering source of truth** — ensures cold-start replay matches live processing even when ingress is blocked on image-to-text.
- `timestampSec` (seconds): server-reported time, shown to the AI. For delete events (no server time), derived as `Math.floor(receivedAtMs / 1000)`.
- `utcOffsetMin`: timezone offset captured at the same ingress moment as `receivedAtMs`. Rendering converts `timestampSec` to local time using this per-event offset.

DB queries order by `(received_at, id)`.

### Consistency Above Availability

Highest design principle for ingress transforms: **never admit partially transformed events into the pipeline**. If image-to-text is enabled and an image event has not been fully resolved, that chat session must remain blocked. Timeouts, hangs, and infinite retries are acceptable; inconsistent data is not.

This rule is fail-closed by design:
- Image-to-text failures do **not** degrade to thumbnail-only or empty-alt-text fallback when the feature is enabled.
- A blocked session may stop accepting new events into Projection/Rendering/Driver indefinitely.
- Correctness of the event stream seen by DCP takes priority over latency and availability.

### Session Ingress Queue

Telegram ingress uses a **per-chat ordered commit queue**. Each event captures ingress timestamps immediately, then enters a queue with two phases:
- **Transform**: asynchronous preprocessing (currently image-to-text and thumbnail generation). Later events in the same chat may start transforming before earlier events finish.
- **Commit**: only the oldest contiguous ready prefix is allowed to enter Adaptation → Projection → Rendering. This preserves event order while still allowing speculative preprocessing of later blocked messages.

The queue is fail-closed. If the head event's transform does not succeed, that chat's `nextCommitSeq` does not advance. Later events may finish transforming, but they remain buffered until the blocked head event resolves.

### Dual Telegram Client

- **grammY** (Bot API): receives messages from non-bot users, sends replies, handles `/commands`.
- **gramjs** (User API): fetches history, resolves reply-to chains, sees other bots' messages (invisible to Bot API), receives edit/delete events.

Messages from both clients are deduplicated by `(chatId, messageId)` in the TelegramManager. Userbot events are filtered to bot-joined chats only (`botChats` set, seeded from events table on startup). When the bot version arrives second, its `fileId` is merged into the in-flight message for Bot API download preference. All message/edit/delete events then enter the per-chat ingress queue before Adaptation. Delete events without `chatId` (MTProto private chat deletes) are dropped — `lookupChatId` attempts resolution from the messages table, but if the message was never persisted the event is lost.

### Phantom Edit Filtering

MTProto fires `updateEditMessage` for metadata-only changes (link preview loading, reactions in large supergroups, inline keyboard updates). These have no `editDate`. The userbot handler skips events without `editDate` — if reactions support is added later, use `updateMessageReactions` separately.

### IC Mutation Semantics

Edit and delete events come exclusively from the userbot (gramjs / MTProto). Bot API does not push these notifications — without the userbot client, edits and deletes would not exist in the system.

Two categories of IC mutation with different KV cache properties:
- **In-place** (edit, delete): modify existing IC nodes at their original position with marks (`editedAtSec`, `deleted: true`). Causes KV cache miss from that point onward. Acceptable — edits are infrequent and usually recent.
- **Append-only** (user rename, future: join/leave): insert system event nodes at the end. Old messages keep their original `sender` field. Rendering uses `node.sender` (name at message time), not `ic.users`. KV-cache friendly.

Design rule: metadata changes about entities → append-only; content changes to specific messages → in-place with marks.

### HTTP Credential Redaction

`src/http.ts` exposes `registerHttpSecret(secret)`. Registered strings are masked with equal-length `*` in all `HttpError` messages. Bot token is registered at client creation.

### Message Scheduling

Projection runs immediately on every event — IC is always current. Scheduling is owned by the **Driver**. Current strategy: **immediate trigger + natural batching** — the reply effect fires as soon as new external messages are detected (`setTimeout(0)` only exits the synchronous signal graph). The `running` flag prevents concurrent LLM calls; messages arriving during a call accumulate and are picked up on the next run. No debounce/throttle is currently implemented. Bot responds via `send_message` tool call (not 1:1 response).

Scheduling lives in Driver (not a separate orchestration layer) because the Driver already manages the reactive scheduling graph (signal/computed/effect) — externalizing it would create coordination overhead.

### Tool Call Loop Interleaving

Each LLM API call = one TR (not the entire loop as one TR). Each TR stores the complete output of one step: assistant response + tool results produced by executing that step's tool calls. When new external chat messages arrive during a tool call loop, the Driver's `checkInterrupt` detects the RC change and breaks the loop. The reactive effect then re-schedules a new LLM call, composing fresh context from the latest RC (which now includes the new messages) and all persisted TRs. New messages' `receivedAtMs` > previous TR's `requestedAtMs` (causality), so they merge correctly after the TR. This is an **interrupt + re-schedule** mechanism, not mid-loop re-rendering — the interrupted loop exits, and a completely new call starts with a fresh step budget and updated system prompt. See `docs/dcp-design.md §Tool Call Loop Interleaving` for merge details.

### Reasoning Signature Sanitization

Anthropic models return reasoning as thinking text + cryptographic signature. The signature is only valid within the same provider family. Each TR records its `reasoningSignatureCompat` group. On replay: same compat → keep reasoning (model can resume); different/empty → strip all reasoning fields. In openai-chat format, reasoning appears as `reasoning_text` + `reasoning_opaque` fields on assistant entries. In responses format, reasoning appears as output items with `type: 'reasoning'`, carrying `encrypted_content` and `summary`. The pair is always kept or stripped together. Format conversion preserves reasoning through round-trips (`encrypted_content` ↔ `reasoning_opaque`, `summary` ↔ `reasoning_text`).

### Debug Dumps

Driver writes the full LLM request JSON to `/tmp/cahciua/<chatId>.request.json` before each API call. This is intentional debug output — the project is not production-deployed. Do not flag as an issue.

### RC and TRs — Orthogonal Merge

RC (from Rendering) and TRs (from Driver) are two independent sorted streams:
- RC segments carry `receivedAtMs` (milliseconds, from source events)
- TRs carry `requestedAtMs` (milliseconds, `Date.now()` at API request time)

Driver merges them by timestamp into the final LLM API messages array. Causality guarantees correct ordering in online operation. **Mandatory tiebreaker**: when timestamps are equal, RC is ordered before TRs — required because Anthropic Messages API enforces strict user/assistant role alternation.

Data flows strictly forward (no backflow). Events table stores only IM platform events. IC is only derived from platform events. Driver is sole owner of TRs.

### TR Storage

TRs are stored in a `turn_responses` DB table (raw provider format, not provider-agnostic). Each TR records its `provider` field (`'openai-chat'` or `'responses'`). One row per TR:

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | autoincrement |
| chat_id | TEXT NOT NULL | Session ID (= Telegram chat ID) |
| requested_at | INTEGER NOT NULL | millisecond timestamp, merge ordering key |
| provider | TEXT NOT NULL | `'openai-chat'` or `'responses'` |
| data | TEXT (JSON) NOT NULL | raw provider response entries (`unknown[]` — openai-chat: `TRDataEntry[]`, responses: output items + function_call_outputs) |
| session_meta | TEXT (JSON) | deprecated — compaction now uses dedicated `compactions` table |
| input_tokens | INTEGER NOT NULL | for statistics / cost tracking |
| output_tokens | INTEGER NOT NULL | for statistics / cost tracking |
| reasoning_signature_compat | TEXT DEFAULT '' | provider compat group for reasoning signature validation |

Same-provider reads are zero-conversion. Cross-provider reads use explicit A→B converter functions.

See `docs/dcp-design.md` for detailed design rationale, theoretical model, and provider-specific metadata reference.

### Anti-Injection

User content in the rendered context is fenced with XML structure. Identity information (who said what) is carried as XML attributes (the truth source), not inline text that users could spoof.

### KV Cache Optimization

- System prompt is static and positioned first.
- Chat history is append-only within an epoch.
- **Current**: Dynamic action hints (probe / mention / reply state) are injected by the Driver as a final synthetic user message via `injectLateBindingPrompt()`.
- **Planned**: Richer dynamic content (memory recall, cross-session awareness) should continue to be injected by the Driver through a more structured late-binding mechanism.
- Compaction creates epoch boundaries — see [Context Compaction](#context-compaction) below.

### isSelfSent Pipeline

Bot's own sent messages are marked `isSelfSent: true` at creation time (in the synthetic event bypass in `src/index.ts`). This flag flows through the full pipeline: `CanonicalMessageEvent.isSelfSent` → `events.is_self_sent` (DB) → `ICMessage.isSelfSent` → `RenderedContextSegment.isSelfSent`. The flag is set at creation, not derived from sender ID (bot may change accounts).

### Feature Flags

Feature flags for experimental optimizations. Controlled via `config.yaml` under the `features` key. Defined in `src/config/config.ts` as part of the `Config` schema, loaded at startup, passed to Driver via `DriverConfig.featureFlags`.

| Flag | Config Key | Effect |
|------|------------|--------|
| `trimStaleNoToolCallTurnResponses` | `features.trimStaleNoToolCallTurnResponses` | Keep only latest 5 TRs without tool calls; older pure-text TRs are dropped before merge |
| `trimSelfMessagesCoveredBySendToolCalls` | `features.trimSelfMessagesCoveredBySendToolCalls` | Filter RC segments with `isSelfSent=true` from context assembly (removes duplicate representation — bot messages exist in both RC via userbot and TRs via tool call results) |
| `trimToolResults` | `features.trimToolResults` | Distance-based mechanical trimming of `TRToolResultEntry.content` in older TRs (keep last 2 untrimmed, trim results >512 chars in older ones). Keeps `TRAssistantEntry` (call structure + reasoning) intact |

Feature flags must not affect correctness — only context efficiency. Add new flags to the `features` section in `ConfigSchema` in `src/config/config.ts` and this table.

### Context Compaction

Compaction proactively summarizes historical conversation context to prevent LLM context overflow. Implemented as an independent reactive effect (`alien-signals`) that runs in parallel with the main reply flow.

**Dual water mark strategy** (all thresholds use estimated tokens via `CHARS_PER_TOKEN = 2` heuristic, not actual tokenizer counts):
- **High water mark** (`compaction.maxContextEstTokens`): compaction triggers when estimated raw content (RC + TRs after cursor, excluding summary) exceeds this threshold.
- **Low water mark** (`compaction.workingWindowEstTokens`): after compaction, only this many estimated tokens of raw content are retained in the working window. The rest is replaced by a structured summary prepended as the first user message.

**Data flow**:
1. `compactionMeta` signal initialized from DB on cold start (`loadCompaction`)
2. `cursorMs` and `summary` derived as `computed()` from `compactionMeta`
3. Cursor auto-apply effect watches `cursorMs` → calls `pipeline.setCompactCursor()` → pipeline re-renders RC excluding segments before cursor
4. Reply effect reads `cursorMs()` and `summary()` from signals — no runtime DB queries
5. Compaction effect: when `estimatedTokens > maxContextEstTokens`, calls `runCompaction()` → `persistCompaction()` → updates `compactionMeta` signal → cursor effect auto-applies

**Compaction storage** (`compactions` table): append-only — each compaction inserts a new row. `loadCompaction` reads the latest by `ORDER BY id DESC LIMIT 1`. Rolling back = deleting the latest row. Never upsert.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | autoincrement |
| chat_id | TEXT NOT NULL | indexed |
| old_cursor_ms | INTEGER NOT NULL | start of compacted window |
| new_cursor_ms | INTEGER NOT NULL | end of compacted window (= new cursor position) |
| summary | TEXT NOT NULL | structured plain-text summary |
| input_tokens | INTEGER NOT NULL | LLM input tokens for this compaction call |
| output_tokens | INTEGER NOT NULL | LLM output tokens for this compaction call |
| created_at | INTEGER NOT NULL | millisecond timestamp |

**Compaction is NOT a turn**: compaction has its own dedicated table, not stored in `turn_responses`. It produces a summary (pure text with structured sections), not a provider-format response.

**Token estimation**: Context size is estimated using a `CHARS_PER_TOKEN = 2` heuristic (not an actual tokenizer). Summary size is excluded from the compaction trigger check to prevent the summary from growing until it fills the budget (which would degrade compaction into a sliding window). `findWorkingWindowCursor` counts both RC segments and TRs when determining the cursor position.

**Config** (`compaction` section in `config.yaml`):
- `enabled` (boolean, default `false`): whether to run compaction. When disabled, existing compaction data is still loaded (cursor + summary applied), but no new compaction runs.
- `maxContextEstTokens` (number, default `200000`): high water mark — trigger compaction when estimated context exceeds this. Also used by `trimContext` to cap the LLM request size.
- `workingWindowEstTokens` (number, default `8000`): low water mark — how many estimated tokens of raw content to retain after compaction.
- `model` (string, optional): override model for compaction LLM calls (references a key in the `models` registry). Defaults to `llm.model`.
- `dryRun` (boolean, default `false`): call LLM and log summary, but don't persist or apply.

**Empty content sanitization**: Anthropic API rejects assistant messages with empty `content` (empty string, null, or pure-thinking entries with no content/tool_calls). `composeContext` sanitizes these: `content: '' | null | undefined` → `delete content`; empty-shell assistant messages (no content, no tool_calls) are filtered out entirely.

### Probe / Activate Gate

In group chats, most messages don't require a bot response. To avoid wasting tokens on the primary (large) model, the Driver supports a **probe gate**: when the bot hasn't been recently @'d or replied to, a small/cheap probe model runs first. If the probe chooses silence (no tool calls), the primary model is skipped. If the probe produces tool calls (intent to act), its result is discarded and the primary model is activated with the same context.

**Terminology**:
- **Probe model**: small/cheap model configured independently (`probe` config section)
- **Primary model**: the main `llm` section model
- **Probe**: single-step LLM call with no tool execution, result stored but not acted upon
- **Activate**: probe detected tool calls → discard probe, run primary model step loop

**Flow** (in Driver reply effect, after debounce):
1. Compose context (same as normal flow)
2. Check `needsProbe`: `probe.enabled && lastMentionedAtMs <= lastTrTimeMs`
   - `lastMentionedAtMs`: max `receivedAtMs` of RC segments with `mentionsMe` or `repliesToMe` set
   - `mentionsMe`: RC segment's source message content contains a `<mention>` node targeting bot's userId
   - `repliesToMe`: RC segment's source message replies to a bot message
3. If probe needed: call LLM with probe model (same context, same tools, single call — supports both `openai-chat` and `responses` API formats)
   - No tool calls → persist probe response (`is_activated=false`), return (bot stays silent)
   - Has tool calls → persist probe response (`is_activated=true`), fall through to primary step loop
4. If probe not needed (bot was mentioned/replied to): skip probe, run primary step loop directly

**Probe responses** are stored in a dedicated `probe_responses` table (not in `turn_responses`). They do not participate in `composeContext` — probe TRs never enter the LLM context. They exist purely for debugging and analysis.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | autoincrement |
| chat_id | TEXT NOT NULL | indexed |
| requested_at | INTEGER NOT NULL | millisecond timestamp |
| provider | TEXT NOT NULL | `'openai-chat'` or `'responses'` |
| data | TEXT (JSON) NOT NULL | probe LLM output |
| input_tokens | INTEGER NOT NULL | token stats |
| output_tokens | INTEGER NOT NULL | token stats |
| reasoning_signature_compat | TEXT DEFAULT '' | provider compat group |
| is_activated | INTEGER NOT NULL DEFAULT 0 | whether probe triggered primary activation |
| created_at | INTEGER NOT NULL | millisecond timestamp |

**Config** (`probe` section in `config.yaml`):
- `enabled` (boolean, default `false`): whether to use probe gate
- `model`: probe model (references a key in the `models` registry)

### Image To Text

Optional blocking ingress transform that resolves image attachments into cached alt text before they enter DCP.

**Processing model**:
- Only image events with unresolved image attachments trigger the workflow.
- Cache key is the sha256 of the generated thumbnail (deterministic sharp WebP output). Both live ingress and cold-start replay produce the same thumbnail from the same image, so the cache key is stable.
- The LLM input image is a resized PNG with long edge capped at 512px (`fit: inside`, no enlargement). This is larger than the chat-context thumbnail budget and is used only for the image-to-text workflow.
- If alt text is present on an attachment, Rendering emits inline `<image ...>alt text</image>` and does **not** attach a separate image buffer content piece.
- Alt text is **never** stored in the `events` table — it is always queried transiently from the `image_alt_texts` table at runtime.
- Only whitelisted chats (`driver.chatIds`) trigger image-to-text resolution.

**Storage** (`image_alt_texts` table): keyed by thumbnail hash.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | autoincrement |
| image_hash | TEXT NOT NULL UNIQUE | sha256 of thumbnail WebP bytes |
| alt_text | TEXT NOT NULL | resolved image description |
| alt_text_tokens | INTEGER NOT NULL | model output token count for the stored alt text |
| created_at | INTEGER NOT NULL | millisecond timestamp |

**Config** (`imageToText` section in `config.yaml`):
- `enabled` (boolean, default `false`): whether to block ingress on image-to-text
- `model`: model for the image-to-text workflow (references a key in the `models` registry)

### Animation To Text

Optional blocking ingress transform that resolves GIF animations and animated stickers into cached alt text, parallel to Image To Text.

**Supported formats**:
- **GIF / Animation** (`type: 'animation'`): Telegram delivers as MP4. Frames extracted via `ffmpeg` (bundled via `ffmpeg-static` npm package).
- **Video sticker** (`type: 'sticker'`, `isVideoSticker: true`): WEBM format. Frames extracted via `ffmpeg`.
- **Animated sticker** (`type: 'sticker'`, `isAnimatedSticker: true`): TGS format (gzipped Lottie JSON). Decompressed with `gunzipSync`, frames rendered via `lottie-frame` native addon (rlottie + libpng).
- **Custom emoji**: not processed (excluded by `canExtractFrames`).

**Frame extraction** (`src/telegram/frame-extractor.ts`):
- Frame selection is **count-based**, not time-based: total frame count is determined first, then ≤maxFrames → keep all, >maxFrames → pick maxFrames equidistant frames (including first and last).
- Frame count sources: GIF → `sharp.metadata().pages`; MP4/WEBM → `ffprobe -show_entries stream=nb_frames`; TGS → Lottie JSON `op - ip`.
- TGS format auto-detected by gzip magic bytes (`0x1f 0x8b`) — does not rely on attachment metadata flags, which may be absent during backfill from `CanonicalAttachment`.
- Each frame is resized to max 512px per edge (same as image-to-text) and encoded as PNG.
- Files >20MB are skipped.

**Processing model**:
- Cache key is `sha256(fileBuffer)` — content-addressable, same animation from different users shares a single cache entry.
- The `animationHash` field is set on the Telegram-layer `Attachment` during live ingress, propagated through adaptation to `CanonicalAttachment`, and persisted in the `events` table attachments JSON. This enables cold-start cache lookup without re-downloading.
- LLM receives all extracted frames as multiple image content parts in a single request. Two separate prompts: `animation-to-text-system.velin.md` for GIFs, `sticker-animation-to-text-system.velin.md` for animated stickers.
- Alt text is stored in the same `image_alt_texts` table (reused from Image To Text — the schema is generic hash → alt text).
- If alt text is present on an animated attachment, Rendering emits `<animation type="...">alt text</animation>` (distinct from static `<image>` tag). Static stickers/photos continue to use `<image>`.

**Cold-start hydration**:
- Events with existing `animationHash`: sync lookup from `image_alt_texts` cache (same as image-to-text).
- Events missing `animationHash` (historical data before feature enablement): backfilled asynchronously after `telegram.start()` — files are re-downloaded via userbot (with Bot API fileId fallback from messages table), frames extracted, hash computed, and the events table is updated.

**System dependencies**:
- `ffmpeg-static` (npm, bundled binary) — provides `ffmpeg` for MP4/WEBM processing.
- `ffprobe-static` (npm, bundled binary) — provides `ffprobe` for video frame count detection.
- `lottie-frame` (npm, native C++ addon) — renders Lottie JSON frames to PNG. Requires system packages: `libpng-dev` and `librlottie-dev` (`apt-get install -y libpng-dev librlottie-dev`).

**Config** (`animationToText` section in `config.yaml`):
- `enabled` (boolean, default `false`): whether to block ingress on animation-to-text
- `model`: model for the animation-to-text workflow (references a key in the `models` registry)
- `maxFrames` (number, default `5`): maximum equidistant frames to extract from each animation

## Coding Conventions

- **Functional style**: `const` + arrow functions everywhere, closure-based factories. Use classes only when required by library APIs (grammY, gramjs) or for `Error` subclasses.
- **Strict types**: avoid `any`; use `unknown` + narrowing. `noUncheckedIndexedAccess` is enabled.
- **Consistent type imports**: use `import type { ... }` for type-only imports (enforced by ESLint).
- **File names**: `kebab-case`.
- **Validation**: use Valibot for runtime schema validation; keep schemas close to their consumers.
- **Immutable state**: use Immer's `produce()` in Projection reducers.
- **Error handling**: prefer explicit error returns or Result types over thrown exceptions for expected failures.
- **Logging**: use `@guiiai/logg` (`useLogger` / `useGlobalLogger`) for all runtime logs. Never use `console.log` for logging. `console.log` is only acceptable in CLI scripts for outputting raw data the user needs to copy (e.g. session strings).
- **No speculative code**: if a design isn't settled, don't write a wrong placeholder. Either leave a `// TODO:` explaining the initial thinking, or don't write it at all. Wrong code looks authoritative and misleads future work.

## Styling Rules (enforced by ESLint)

- 2-space indent, single quotes, semicolons, trailing commas in multiline.
- `1tbs` brace style (single-line allowed).
- Interface/type members delimited by semicolons.
- Arrow parens only when needed (`as-needed`).
- Unix line endings.

## Testing Practices

- Use Vitest. Test files live next to source as `*.test.ts`.
- Projection reducers are pure functions — test them with static CanonicalIMEvent fixtures.
- Mock Telegram clients and DB for integration tests.
- Driver, persistence, and Telegram integration are now complexity hotspots — expand test coverage there when behavior changes.
- When fixing a bug, add a test that reproduces the previous failure.

## Comments & Markers

- **Don't write comments that restate what the code already says.** Function names, type signatures, and variable names should be self-documenting. If a comment just paraphrases the code, delete it.
- **No file-header JSDoc blocks** (e.g. `/** This module does X. Responsibilities: ... */`). The file name and exports are enough.
- **No JSDoc on interface fields** when the field name is self-explanatory (e.g. `/** The chat ID. */ chatId: string` is noise).
- **No JSDoc on functions** unless the behavior is genuinely surprising or non-obvious from the signature.
- **Do comment** non-obvious logic, workarounds, edge cases, and "why" (not "what").
- Use markers consistently: `// TODO:`, `// REVIEW:`, `// NOTICE:`.
- Keep comments with the code when refactoring. If removing a comment, note why.

## Dependency Management

- Use `pnpm add <dep>` / `pnpm add -D <dep>` to add dependencies. Do not edit `package.json` by hand.
- Always run `pnpm typecheck` and `pnpm lint:fix` after finishing a task.

## Data Migration Principle

When existing data doesn't match the current schema or design, fix it with a **DB migration** (SQL UPDATE in a new migration file). Never add backward-compatibility code or runtime fallbacks to handle old data formats — code should only handle the latest design. This keeps the codebase clean and avoids accumulating compatibility shims.

## Commit Conventions

- Use Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, etc.
- Keep commits focused and scoped.
- When a commit changes project structure, key patterns, or completes a milestone, update this file in the same commit.
- **NEVER commit or push without explicit human instruction.** Always wait for the user to verify changes, run the application, and explicitly request a commit. Unauthorized commits are strictly forbidden.
