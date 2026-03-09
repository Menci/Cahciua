# Cahciua Agent Guide

Reference for contributors working on the Cahciua codebase. Improve code when you touch it; avoid one-off patterns.

## What Is Cahciua

Cahciua is a Telegram group chat bot built on the **Deterministic Context Pipeline (DCP)** architecture. DCP constructs LLM context through a three-layer pure-function pipeline:

1. **Adaptation**: Platform Event → Canonical Event (anti-corruption layer).
2. **Projection**: `IC' = Reducers(IC, Event)` — pure-function state machine producing an Intermediate Context (IC).
3. **Rendering**: `IC + SessionState → Messages[]` — serialization with viewport filtering and late-binding injection.

Key design goals: KV Cache friendly (append-only history, static system prompt, epoch-based compaction), group chat native (message batching, multi-user identity tracking, anti-injection via XML fencing), autonomous reply (bot decides whether to respond via Tool Call, not synchronous response).

## Tech Stack

- **Runtime**: Node.js (>=22), TypeScript, tsx (dev), tsdown (build).
- **Telegram Bot API**: grammY — primary message handling, sending replies, commands.
- **Telegram User API**: gramjs (`telegram` on npm) — MTProto client for history fetching, reply-to context resolution, seeing other bots' messages.
- **LLM**: xsAI (planned) — ultra-lightweight OpenAI-compatible SDK.
- **Database**: SQLite via better-sqlite3, Drizzle ORM.
- **State management**: Immer — immutable IC updates in Projection reducers.
- **Validation**: Valibot — schema validation for env, config, canonical events.
- **Logging**: @guiiai/logg — structured logger with pretty/JSON output.
- **Testing**: Vitest.
- **Linting**: ESLint with `@typescript-eslint`, `@stylistic/eslint-plugin`, `eslint-plugin-import`.
- **Package manager**: pnpm (hoisted `node_modules` via `.npmrc`).

## Project Structure

```
src/
├── index.ts              # Entry point
├── config/
│   ├── env.ts            # Environment variable schema (Valibot)
│   ├── logger.ts         # pino logger
│   └── index.ts
├── adaptation/           # Layer 1: Platform Event → Canonical Event
│   ├── types.ts          # CanonicalEvent, CanonicalMessage, CanonicalUser, CanonicalAttachment
│   └── index.ts
├── projection/           # Layer 2: IC' = Reducers(IC, Event)
│   ├── types.ts          # IntermediateContext, ICMessage, ICUserState
│   └── index.ts
├── rendering/            # Layer 3: IC + SessionState → Messages[]
│   ├── types.ts          # SessionState, RenderedMessage
│   └── index.ts
└── telegram/             # Dual-client Telegram integration
    ├── bot.ts            # grammY Bot API client
    ├── userbot.ts        # gramjs MTProto User API client
    └── index.ts
```

### Imports

Use relative paths for all internal imports:
```ts
import { logger } from '../config/logger';
import type { CanonicalEvent } from '../adaptation/types';
```

## Commands

- `pnpm dev` — run with file watching (tsx watch).
- `pnpm start` — run once (tsx).
- `pnpm build` — bundle with tsdown.
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm lint` / `pnpm lint:fix` — ESLint.
- `pnpm test` / `pnpm test:run` — Vitest.

## Architecture Rules

### DCP Layers Are Pure Functions

Projection reducers must be pure: `(IC, CanonicalEvent) => IC'`. No I/O, no side effects, no network calls. All external data (memory, user profiles) enters through the Rendering layer's late-binding mechanism or as pre-fetched fields on the CanonicalEvent.

### Dual Telegram Client

- **grammY** (Bot API): receives messages from non-bot users, sends replies, handles `/commands`.
- **gramjs** (User API): fetches history on startup/join, resolves reply-to chains for messages the bot hasn't seen, listens for other bots' messages (invisible to Bot API).

Messages from both clients are deduplicated by `(chatId, messageId)` in the Adaptation layer before entering the pipeline.

### Message Batching

Group messages are debounced/batched before triggering LLM inference. The bot does not respond to every message — it receives a batch of Canonical Events, updates the IC, then the LLM decides whether to reply via a `send_message` Tool Call.

### Anti-Injection

User content in the rendered context is fenced with XML structure. Identity information (who said what) is carried as XML attributes (the truth source), not inline text that users could spoof.

### KV Cache Optimization

- System prompt is static and positioned first.
- Chat history is append-only within an epoch.
- Dynamic content (memory recall, cross-session awareness) is injected at the end of the last user message via late binding.
- Compaction replaces old messages with a summary rather than sliding a window per-turn.

## Coding Conventions

- **Functional style**: prefer plain functions and composition over classes. Use classes only when required by library APIs (grammY, gramjs).
- **Strict types**: avoid `any`; use `unknown` + narrowing. `noUncheckedIndexedAccess` is enabled.
- **Consistent type imports**: use `import type { ... }` for type-only imports (enforced by ESLint).
- **File names**: `kebab-case`.
- **Validation**: use Valibot for runtime schema validation; keep schemas close to their consumers.
- **Immutable state**: use Immer's `produce()` in Projection reducers.
- **Error handling**: prefer explicit error returns or Result types over thrown exceptions for expected failures.
- **Logging**: use `@guiiai/logg` (`useLogger` / `useGlobalLogger`) for all runtime logs. Never use `console.log` for logging. `console.log` is only acceptable in CLI scripts for outputting raw data the user needs to copy (e.g. session strings).

## Styling Rules (enforced by ESLint)

- 2-space indent, single quotes, semicolons, trailing commas in multiline.
- `1tbs` brace style (single-line allowed).
- Interface/type members delimited by semicolons.
- Arrow parens only when needed (`as-needed`).
- Unix line endings.

## Testing Practices

- Use Vitest. Test files live next to source as `*.test.ts`.
- Projection reducers are pure functions — test them with static CanonicalEvent fixtures.
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
