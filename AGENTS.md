# Cahciua Agent Guide

Reference for contributors working on the Cahciua codebase. Improve code when you touch it; avoid one-off patterns.

**Maintenance rule**: When you add, rename, or remove a file, change a key pattern, or complete a milestone — update this file in the same commit. Outdated docs are worse than no docs.

## What Is Cahciua

Cahciua is a Telegram group chat bot built on the **Deterministic Context Pipeline (DCP)** architecture. DCP constructs LLM context through a three-layer pure-function pipeline:

1. **Adaptation**: Platform Event → CanonicalIMEvent (anti-corruption layer).
2. **Projection**: `IC' = Reducers(IC, CanonicalIMEvent)` — pure-function state machine producing an Intermediate Context (IC).
3. **Rendering**: `RC = Render(IC, RenderParams)` — serialization with viewport filtering and late-binding injection, producing Rendered Context (RC).

The Driver layer sits after Rendering: it merges RC (chat context) with its own Turns (bot responses, tool results) by timestamp to assemble the final LLM API request. Driver owns compaction, provider-specific adaptation, and tool call loops.

Key design goals: KV Cache friendly (append-only history, static system prompt, epoch-based compaction), group chat native (message batching, multi-user identity tracking, anti-injection via XML fencing), autonomous reply (bot decides whether to respond via Tool Call, not synchronous response).

## Current Progress

| Layer | Status | Notes |
|-------|--------|-------|
| Telegram integration | Done | Bot + userbot, dedup, thumbnail, fileId merge, credential redaction |
| Adaptation | Done | Types, conversion, dual timestamps, phantom edit filtering |
| DB / Persistence | Done | events table (canonical), messages table (raw platform), 5 migrations |
| Projection | Types only | `projection/types.ts` has IC shape; no reducers yet |
| Rendering | Types only | `rendering/types.ts` has RC shape (RenderedContext); no implementation |
| Driver | Not started | Merges RC + Turns, owns compaction and tool call loops |

## Tech Stack

- **Runtime**: Node.js (>=22), TypeScript, tsx (dev), tsdown (build).
- **Telegram Bot API**: grammY — primary message handling, sending replies, commands.
- **Telegram User API**: gramjs (`telegram` on npm) — MTProto client for history fetching, reply-to context resolution, seeing other bots' messages.
- **LLM**: xsAI (planned) — ultra-lightweight OpenAI-compatible SDK.
- **Database**: SQLite via better-sqlite3, Drizzle ORM.
- **State management**: Immer (planned) — immutable IC updates in Projection reducers.
- **Validation**: Valibot — schema validation for env, config, canonical events.
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
│   ├── env.ts              # Environment variable schema (Valibot)
│   └── logger.ts           # @guiiai/logg setup (pretty in dev, JSON in prod)
├── adaptation/             # Layer 1: Platform Event → Canonical Event
│   ├── types.ts            # CanonicalIMEvent (discriminated union), CanonicalUser, etc.
│   └── index.ts            # adaptMessage, adaptEdit, adaptDelete + re-exports
├── projection/             # Layer 2: IC' = Reducers(IC, Event)
│   └── types.ts            # IntermediateContext, ICMessage, ICUserState
├── rendering/              # Layer 3: IC + RenderParams → RenderedContext (RC)
│   └── types.ts            # RenderParams, RenderedSegment, RenderedContext
├── db/
│   ├── client.ts           # Database init (better-sqlite3 + Drizzle), WAL mode
│   ├── schema.ts           # Drizzle schema: users, messages, events tables
│   ├── persistence.ts      # CRUD: persistEvent, persistMessage, loadEvents, etc.
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

### Type Ownership

Platform types (`Attachment`, `ForwardInfo`, `MessageEntity`) are defined in `telegram/message/types.ts` — they belong to the telegram layer. `db/schema.ts` imports them for JSON column annotations. Never define platform types in the DB layer.

Canonical types (`CanonicalIMEvent`, `CanonicalUser`, etc.) are defined in `adaptation/types.ts`.

### Imports

Use relative paths for all internal imports:
```ts
import { loadEnv } from './config/env';
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
- `receivedAt` (milliseconds): local receive time, set by `Date.now()` at adaptation. **Ordering source of truth** — ensures cold-start replay matches live processing.
- `timestamp` (seconds): server-reported time, shown to the AI. For delete events (no server time), derived as `Math.floor(receivedAt / 1000)`.

DB queries order by `(received_at, id)`.

### Dual Telegram Client

- **grammY** (Bot API): receives messages from non-bot users, sends replies, handles `/commands`.
- **gramjs** (User API): fetches history, resolves reply-to chains, sees other bots' messages (invisible to Bot API), receives edit/delete events.

Messages from both clients are deduplicated by `(chatId, messageId)` in the TelegramManager. Userbot events are filtered to bot-joined chats only (`botChats` set, seeded from events table on startup). When the bot version arrives second, its `fileId` is merged into the in-flight message for Bot API download preference.

### Phantom Edit Filtering

MTProto fires `updateEditMessage` for metadata-only changes (link preview loading, reactions in large supergroups, inline keyboard updates). These have no `editDate`. The userbot handler skips events without `editDate` — if reactions support is added later, use `updateMessageReactions` separately.

### HTTP Credential Redaction

`src/http.ts` exposes `registerHttpSecret(secret)`. Registered strings are masked with equal-length `*` in all `HttpError` messages. Bot token is registered at client creation.

### Message Batching

Projection runs immediately on every event — IC is always current. Rendering + Driver invocation is debounced/throttled — each trigger produces one RC and one LLM API call. The debounce/throttle parameters are strategy (tunable, graded via fixtures). Bot responds via `send_message` tool call (not 1:1 response).

### RC and Turns — Orthogonal Merge

RC (from Rendering) and Turns (from Driver) are two independent sorted streams:
- RC segments carry `receivedAt` (milliseconds, from source events)
- Turns carry `requestedAt` (milliseconds, `Date.now()` at API request time)

Driver merges them by timestamp into the final LLM API messages array. Causality guarantees correct ordering in online operation. **Mandatory tiebreaker**: when timestamps are equal, RC is ordered before Turns — required because Anthropic Messages API enforces strict user/assistant role alternation.

Data flows strictly forward (no backflow). Events table stores only IM platform events. IC is only derived from platform events. Driver is sole owner of Turns.

### Turn Storage

Turns are stored in a `turns` DB table (raw provider format, not provider-agnostic). One row per Turn:

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | autoincrement |
| chat_id | TEXT NOT NULL | Session ID (= Telegram chat ID) |
| requested_at | INTEGER NOT NULL | millisecond timestamp, merge ordering key |
| provider | TEXT NOT NULL | e.g. 'openai-chat', 'anthropic-messages' |
| data | TEXT (JSON) NOT NULL | raw provider response entries (assistant message + tool results) |
| session_meta | TEXT (JSON) | top-level state from response (e.g. response.id for Responses API) |
| input_tokens | INTEGER NOT NULL | for statistics / cost tracking |
| output_tokens | INTEGER NOT NULL | for statistics / cost tracking |
| response_envelope | TEXT (JSON) | raw response with content stripped (model, finish_reason, usage, etc.) |

Same-provider reads are zero-conversion. Cross-provider reads use explicit A→B converter functions.

See `docs/dcp-design.md` for detailed design rationale, theoretical model, and provider-specific metadata reference.

### Anti-Injection

User content in the rendered context is fenced with XML structure. Identity information (who said what) is carried as XML attributes (the truth source), not inline text that users could spoof.

### KV Cache Optimization

- System prompt is static and positioned first.
- Chat history is append-only within an epoch.
- Dynamic content (memory recall, cross-session awareness) is injected at the end of the last user message via late binding.
- Compaction replaces old messages with a summary rather than sliding a window per-turn.

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

## Commit Conventions

- Use Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, etc.
- Keep commits focused and scoped.
- When a commit changes project structure, key patterns, or completes a milestone, update this file in the same commit.
