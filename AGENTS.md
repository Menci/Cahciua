# Cahciua Agent Guide

Reference for contributors working on the Cahciua codebase. Improve code when you touch it; avoid one-off patterns.

**Maintenance rule**: When you add, rename, or remove a file, change a key pattern, or complete a milestone — update this file in the same commit. Outdated docs are worse than no docs.

## What Is Cahciua

Cahciua is a Telegram group chat bot built on the **Deterministic Context Pipeline (DCP)** architecture. DCP constructs LLM context through a three-layer pure-function pipeline:

1. **Adaptation**: Platform Event → CanonicalIMEvent (anti-corruption layer).
2. **Projection**: `IC' = Reducers(IC, CanonicalIMEvent)` — pure-function state machine producing an Intermediate Context (IC).
3. **Rendering**: `RC = Render(IC, RenderParams)` — serialization with viewport filtering and late-binding injection, producing Rendered Context (RC).

The Driver layer sits after Rendering: it merges RC (chat context) with its own TRs (bot responses, tool results) by timestamp to assemble the final LLM API request. Driver owns compaction, provider-specific adaptation, and tool call loops.

Key design goals: KV Cache friendly (append-only history, static system prompt, epoch-based compaction), group chat native (message batching, multi-user identity tracking, anti-injection via XML fencing), autonomous reply (bot decides whether to respond via Tool Call, not synchronous response).

## Current Progress

| Layer | Status | Notes |
|-------|--------|-------|
| Telegram integration | Done | Bot + userbot, dedup, thumbnail, fileId merge, credential redaction |
| Adaptation | Done | Types, conversion, dual timestamps, rich text parsing, string IDs, phantom edit filtering |
| DB / Persistence | Done | events, messages, turn_responses tables; 16 migrations |
| Projection | Done | Reducer (message/edit/delete), MetaReducer (user rename detection), Immer-based immutability |
| Rendering | Done | `render(IC, RenderParams) → RC`, XML serialization, viewport filtering, thumbnail content pieces |
| Driver | Done | xsai `chat()` + manual tool execution, per-step TR persistence, mid-turn interruption, reasoning sanitization, reactive orchestration (alien-signals) |

## Tech Stack

- **Runtime**: Node.js (>=22), TypeScript, tsx (dev), tsdown (build).
- **Telegram Bot API**: grammY — primary message handling, sending replies, commands.
- **Telegram User API**: gramjs (`telegram` on npm) — MTProto client for history fetching, reply-to context resolution, seeing other bots' messages.
- **LLM**: xsAI — `chat()` primitive for single API calls + manual tool execution loop. `generateText()` not used (its internal tool loop swallows per-step data).
- **Database**: SQLite via better-sqlite3, Drizzle ORM.
- **State management**: Immer — immutable IC updates in Projection reducers.
- **Reactivity**: alien-signals — signal/computed/effect graph for Driver orchestration.
- **Validation**: Valibot — schema validation for config, canonical events.
- **Logging**: @guiiai/logg — structured logger with pretty/JSON output.
- **Testing**: Vitest.
- **Linting**: ESLint with `@typescript-eslint`, `@stylistic/eslint-plugin`, `eslint-plugin-import`.
- **Package manager**: pnpm (hoisted `node_modules` via `.npmrc`).

## Project Structure

```
src/
├── index.ts                # Entry point — wires adaptation, persistence, telegram
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
│   ├── types.ts            # TurnResponse, DriverConfig
│   ├── context.ts          # Pure functions: context composition, token trimming, reasoning sanitization
│   ├── merge.ts            # mergeContext(RC, TRs) → Message[] — timestamp-ordered interleave
│   ├── merge.test.ts       # Merge logic tests
│   ├── runner.ts           # LLM step loop: xsai chat() + manual tool execution
│   ├── prompt.ts           # System prompt rendering (velin template)
│   ├── system-prompt.test.ts # System prompt tests
│   ├── tools.ts            # send_message tool definition (xsai Tool)
│   └── index.ts            # createDriver() — reactive orchestration (alien-signals)
├── db/
│   ├── client.ts           # Database init (better-sqlite3 + Drizzle), WAL mode
│   ├── schema.ts           # Drizzle schema: users, messages, events, turnResponses tables
│   ├── persistence.ts      # CRUD: persistEvent, persistMessage, persistTurnResponse, loadEvents, loadTurnResponses, etc.
│   └── index.ts            # Barrel exports
└── telegram/
    ├── index.ts             # TelegramManager — unified facade, thumbnail hydration, dedup dispatch
    ├── bot.ts               # grammY Bot API client
    ├── userbot.ts           # gramjs MTProto client
    ├── event-bus.ts         # Simple typed pub/sub
    ├── thumbnail.ts         # sharp-based thumbnail generation (512×512 webp)
    ├── gramjs-logger.ts     # Patches gramjs internal logger to @guiiai/logg
    ├── session.ts           # Session file load/save
    ├── login.ts             # Interactive MTProto login script (pnpm login)
    └── message/
        ├── types.ts         # TelegramUser, TelegramMessage, Attachment, ForwardInfo, MessageEntity
        ├── gramjs.ts        # gramjs Api.Message → TelegramMessage conversion
        ├── grammy.ts        # grammY Message → TelegramMessage conversion
        ├── dedup.ts         # Set-based message dedup with LRU eviction (10k)
        └── index.ts         # Barrel exports
```

Top-level docs:
- `docs/dcp-design.md` — architecture rationale and Driver/TR design
- `dcp-updates.md` — implementation deltas from the original RFC
- `gpt-review.md` — repository-wide code/doc review notes and consistency audit

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
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm lint` / `pnpm lint:fix` — ESLint.
- `pnpm test` / `pnpm test:run` — Vitest.
- `pnpm login` — interactive MTProto session login.
- `pnpm db:generate` — generate Drizzle migration from schema changes.

## Architecture Rules

### DCP Layers Are Pure Functions

Projection reducers must be pure: `(IC, CanonicalIMEvent) => IC'`. No I/O, no side effects, no network calls. Projection only processes IM platform events — bot's own LLM interactions live exclusively in the Driver layer (unidirectional data flow, no backflow). External data (memory, user profiles) enters through Rendering's late-binding mechanism or as pre-fetched fields on the event.

### Dual Timestamps

Every `CanonicalIMEvent` carries two timestamps:
- `receivedAtMs` (milliseconds): local receive time, set by `Date.now()` at adaptation. **Ordering source of truth** — ensures cold-start replay matches live processing.
- `timestampSec` (seconds): server-reported time, shown to the AI. For delete events (no server time), derived as `Math.floor(receivedAtMs / 1000)`.
- `utcOffsetMin`: timezone offset at adaptation time (`-new Date().getTimezoneOffset()`). Rendering converts `timestampSec` to local time using this per-event offset.

DB queries order by `(received_at, id)`.

### Dual Telegram Client

- **grammY** (Bot API): receives messages from non-bot users, sends replies, handles `/commands`.
- **gramjs** (User API): fetches history, resolves reply-to chains, sees other bots' messages (invisible to Bot API), receives edit/delete events.

Messages from both clients are deduplicated by `(chatId, messageId)` in the TelegramManager. Userbot events are filtered to bot-joined chats only (`botChats` set, seeded from events table on startup). When the bot version arrives second, its `fileId` is merged into the in-flight message for Bot API download preference. Delete events without `chatId` (MTProto private chat deletes) are dropped — `lookupChatId` attempts resolution from the messages table, but if the message was never persisted the event is lost.

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

### Message Batching and Debounce

Projection runs immediately on every event — IC is always current. Debounce/throttle is owned by the **Driver** — each trigger produces one `render(IC)` → one RC → one LLM API call. The debounce/throttle parameters are strategy (tunable, graded via fixtures). Bot responds via `send_message` tool call (not 1:1 response).

Debounce lives in Driver (not a separate orchestration layer) because tool call loops already require the Driver to decide when to re-render IC — externalizing debounce would create coordination overhead.

### Tool Call Loop Interleaving

Each LLM API call = one TR (not the entire loop as one TR). Before each loop iteration, Driver re-renders IC to pick up new chat messages. New messages' `receivedAtMs` > previous TR's `requestedAtMs` (causality), so they merge correctly after the TR's tool results and before the next assistant response. See `docs/dcp-design.md §Tool Call Loop Interleaving` for merge details.

### Reasoning Signature Sanitization

Anthropic models return reasoning as thinking text + cryptographic signature. The signature is only valid within the same provider family. Each TR records its `reasoningSignatureCompat` group. On replay: same compat → keep reasoning (model can resume); different/empty → strip all reasoning fields (`reasoning_text`, `reasoning_opaque`, thinking blocks). The pair is always kept or stripped together.

### Debug Dumps

Driver writes the full LLM request JSON to `/tmp/cahciua/<chatId>.request.json` before each API call. This is intentional debug output — the project is not production-deployed. Do not flag as an issue.

### RC and TRs — Orthogonal Merge

RC (from Rendering) and TRs (from Driver) are two independent sorted streams:
- RC segments carry `receivedAtMs` (milliseconds, from source events)
- TRs carry `requestedAtMs` (milliseconds, `Date.now()` at API request time)

Driver merges them by timestamp into the final LLM API messages array. Causality guarantees correct ordering in online operation. **Mandatory tiebreaker**: when timestamps are equal, RC is ordered before TRs — required because Anthropic Messages API enforces strict user/assistant role alternation.

Data flows strictly forward (no backflow). Events table stores only IM platform events. IC is only derived from platform events. Driver is sole owner of TRs.

### TR Storage

TRs are stored in a `turn_responses` DB table (raw provider format, not provider-agnostic). One row per TR:

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | autoincrement |
| chat_id | TEXT NOT NULL | Session ID (= Telegram chat ID) |
| requested_at | INTEGER NOT NULL | millisecond timestamp, merge ordering key |
| provider | TEXT NOT NULL | e.g. 'openai-chat', 'anthropic-messages' |
| data | TEXT (JSON) NOT NULL | raw provider response entries (assistant message + tool results) |
| session_meta | TEXT (JSON) | reserved for Compaction — compressed summaries replace full historical replay |
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
- Dynamic content (memory recall, cross-session awareness) is injected at the end of the last user message via late binding.
- Compaction replaces old messages with a summary rather than sliding a window per-turn.

### isSelfSent Pipeline

Bot's own sent messages are marked `isSelfSent: true` at creation time (in the synthetic event bypass in `src/index.ts`). This flag flows through the full pipeline: `CanonicalMessageEvent.isSelfSent` → `events.is_self_sent` (DB) → `ICMessage.isSelfSent` → `RenderedContextSegment.isSelfSent`. The flag is set at creation, not derived from sender ID (bot may change accounts).

### Feature Flags

Feature flags for experimental optimizations. Controlled via `config.yaml` under the `features` key. Defined in `src/config/config.ts` as part of the `Config` schema, loaded at startup, passed to Driver via `DriverConfig.featureFlags`.

| Flag | Config Key | Effect |
|------|------------|--------|
| `trimStaleNoToolCallTurnResponses` | `features.trimStaleNoToolCallTurnResponses` | Keep only latest 5 TRs without tool calls; older pure-text TRs are dropped before merge |
| `trimSelfMessagesCoveredBySendToolCalls` | `features.trimSelfMessagesCoveredBySendToolCalls` | Filter RC segments with `isSelfSent=true` from context assembly (removes duplicate representation — bot messages exist in both RC via userbot and TRs via tool call results) |

Feature flags must not affect correctness — only context efficiency. Add new flags to the `features` section in `ConfigSchema` in `src/config/config.ts` and this table.

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
