# Cahciua Agent Guide

Reference for contributors. Improve code when you touch it; avoid one-off patterns.

**Maintenance rule**: when you change a key pattern, invariant, or architectural rule, update this file in the same commit. Per-file descriptions and schema dumps belong in source — don't add them here.

## What Is Cahciua

Telegram group chat bot built on the **Deterministic Context Pipeline (DCP)**:

1. **Adaptation** (`src/adaptation/`): Platform Event → `CanonicalIMEvent` (anti-corruption).
2. **Projection** (`src/projection/`): `IC' = reduce(IC, event)` — pure, Immer-backed.
3. **Rendering** (`src/rendering/`): `RC = render(IC, params)` — XML serialization + viewport filtering.
4. **Driver** (`src/driver/`): merges RC with its own TRs (turn responses) by timestamp, owns tool-call loops, reactive scheduling (alien-signals), compaction, probe gate.

Supports three LLM API formats via direct non-streaming `fetch`: `openai-chat`, `anthropic-messages`, `responses`. TRs are stored in raw provider format; conversion happens only at API boundaries.

Design goals: KV-cache friendly, group-chat native, autonomous reply (bot decides whether to respond via `send_message` tool call).

See `docs/dcp-design.md` for architecture rationale.

## Tech Stack

Node ≥22, TypeScript, pnpm. Telegram: gramjs (MTProto) for both bot and userbot — no Bot API HTTP layer. DB: better-sqlite3 + Drizzle. State: Immer. Reactivity: alien-signals. Validation: Valibot. Prompts: `@velin-dev/core` (all in `prompts/*.velin.md` — never hardcode prompt strings). Logging: `@guiiai/logg`. Tests: Vitest. Media: sharp, ffmpeg-static + ffprobe-static, lottie-frame (needs system `libpng-dev` + `librlottie-dev`).

## Commands

`pnpm dev` (watch) / `pnpm start` / `pnpm build` / `pnpm typecheck` / `pnpm lint[:fix]` / `pnpm test[:run]` / `pnpm login` (MTProto) / `pnpm db:generate` (Drizzle migration).

## Layout

```
src/
├── adaptation/   Platform → CanonicalIMEvent. Canonical types live here.
├── projection/   reduce(IC, event) → IC' (pure, Immer).
├── rendering/    IC + params → RC (XML).
├── driver/       LLM orchestration, tool loop, compaction, probe gate, format conversion.
├── db/           Drizzle schema + persistence. Schema is the source of truth.
├── telegram/     Bot+userbot, ingress queue, media-to-text transforms, frame extraction.
├── config/       YAML loader (Valibot).
├── http.ts       fetch wrapper with credential redaction (registerHttpSecret).
├── pipeline.ts   Per-chat IC/RC state manager.
└── index.ts      Wiring shell.
prompts/          All velin templates.
docs/             Design docs (not prompts).
```

**Type ownership**: platform types (`Attachment`, `MessageEntity`, ...) live in `src/telegram/message/types.ts`. Canonical types (`CanonicalIMEvent`, `ContentNode`, ...) live in `src/adaptation/types.ts`. All IDs in canonical types are strings. DB schema imports platform types for JSON column annotations — never the other way around.

**Imports**: relative paths only. No tsconfig aliases.

## Architecture Invariants

### Purity & data flow

Projection reducers are pure: `(IC, event) => IC'`. No I/O. Only IM platform events feed Projection — bot's own LLM output lives exclusively in Driver TRs. Data flows strictly forward; Driver is the sole owner of TRs.

External data (memory, profiles) enters via Driver-level late binding (`injectLateBindingPrompt()`), not by mutating IC.

### Dual timestamps

Every `CanonicalIMEvent` carries:
- `receivedAtMs` — local ingress time, **captured before any async transform**. Ordering source of truth; DB orders by `(received_at, id)`.
- `timestampSec` — server time, shown to the AI.
- `utcOffsetMin` — captured at ingress; Rendering uses it for local-time display.

### Consistency above availability

**Never admit partially transformed events.** If an ingress transform (image/animation/custom-emoji-to-text) is enabled and a head event hasn't fully resolved, the per-chat queue blocks indefinitely. Timeouts and infinite retries are acceptable; inconsistent data is not. No silent fallback to thumbnail-only / empty alt text.

### Session ingress queue

Per-chat ordered commit queue (`src/telegram/session-ingress-queue.ts`). Later events may transform speculatively, but only the contiguous ready prefix commits into Adaptation. Fail-closed: blocked head ⇒ `nextCommitSeq` does not advance.

### Two Telegram clients, single ingress source

Both bot and userbot are gramjs `TelegramClient` instances over MTProto. The bot is sender-only by default; the userbot, when configured, owns ingress (messages, edits, deletes, typing, history, reply-to resolution) because bots have server-enforced visibility limits regardless of protocol — privacy mode hides most group messages, edit/delete updates are unreliable, history is restricted, and other bots' messages are invisible. Without a userbot session the bot client takes over ingress on its own (with all those limitations).

The unselected client still receives MTProto updates over its own stream; the manager simply doesn't subscribe to them. `apiId`/`apiHash` are unconditionally required (the bot also needs MTProto credentials); the userbot session is the optional knob.

Downloads go through `telegramManager.downloadMessageMedia(chatId, messageId)` — prefers userbot for full visibility, falls back to bot. `(chatId, messageId)` is the only stable handle: MTProto file references include `access_hash` and `file_reference`, which expire, so re-fetching the message is the correct download path.

**Edit/delete come from the active ingress source.** Phantom MTProto edits (no `editDate` — link previews resolved, reactions in some channels, inline keyboard refresh, pin state changes) are still filtered in `userbot.ts`; this is intrinsic to the MTProto stream, unrelated to the old dual-source dedup.

### Configured chat residency

`chats` config = in-memory residency whitelist. Unconfigured chats still persist `events` + `messages` (so the historical archive stays complete) but stop before hydration/Projection/Rendering/Driver.

### IC mutation semantics

- **In-place** (edit, delete): mutate existing IC nodes with marks (`editedAtSec`, `deleted: true`). Costs KV cache from that point. Acceptable for infrequent recent edits.
- **Append-only** (rename, future join/leave): insert system event nodes at the tail. Old messages keep their original `sender` field — Rendering uses `node.sender`, not `ic.users`.

Rule: metadata changes about entities → append-only; content changes to specific messages → in-place with marks.

### Sticker pack title

Raw slug stays in `stickerSetId`; resolved human title goes in `stickerSetName`. Cold-start replay normalizes legacy events that stored the slug in `stickerSetName` and writes back to `events`.

### RC × TR merge

RC carries `receivedAtMs`; TRs carry `requestedAtMs`. Driver merges by timestamp. **Tiebreaker (mandatory)**: RC before TR at equal timestamps — required by Anthropic's strict role alternation.

Each LLM API call = one TR. New external messages during a tool loop trigger `checkInterrupt`, which breaks the loop; the reactive effect re-schedules a fresh call with updated RC. Not mid-loop re-rendering — interrupt + re-schedule.

### Reasoning signature sanitization

Each TR records `reasoningSignatureCompat`. On replay: same compat → keep reasoning; otherwise strip all reasoning fields (thinking text + signature/encrypted content go together). Format conversion preserves the pair: openai-chat `reasoning_text`/`reasoning_opaque` ↔ responses `summary`/`encrypted_content`.

### Tool call ID sanitization

Stored TRs keep provider-native IDs. `composeContext()` always remaps IDs to `[A-Za-z0-9_-]` for the request (Anthropic's regex) — deterministic, collision-safe, never written back to storage.

### Token statistics (cross-provider normalization)

All `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens` columns are normalized at the API boundary in `src/driver/{chat,messages,responses}.ts`:

- `inputTokens` = **total** billable input including cache reads and writes. Anthropic's API returns the uncached remainder only — we add `cache_read_input_tokens + cache_creation_input_tokens` back in to match OpenAI semantics.
- `cacheReadTokens` ≈ 0.1× base input cost (all providers; DeepSeek's `prompt_cache_hit_tokens` also accepted on chat path).
- `cacheWriteTokens` Anthropic-only (~1.25× 5min, ~2× 1h — current code uses 1h via `applyAnthropicCachePoints`). OpenAI/Responses always report 0 here.

Downstream code treats the shape uniformly. See `docs/dcp-design.md` for the cost model.

### Context optimizations (always on in `composeContext`)

- Drop pure-text TRs (no tool calls) beyond the latest 5.
- Filter RC segments with `isSelfSent=true` (bot sends exist as both userbot RC and TR — keep the TR side).
- Mechanically trim oversized (`text >512 chars` or non-`low` image) tool results beyond the latest 5.
- Sanitize empty assistant content for Anthropic (delete empty `content`, drop empty-shell messages).

`isSelfSent` is set at ingress time based on the current bot user ID. Historical events keep their tag from the time of ingress, so changing the bot account doesn't retroactively invalidate them.

### Final send prep

`prepareChatMessagesForSend()` / `prepareResponsesInputForSend()` are the **only** places that convert the internal `Message[]` to wire format. Model `maxImagesAllowed` is enforced here on **every** request — tool-generated images (e.g. `read_image`) cannot bypass per-model caps in later steps, probes, or compaction.

### Compaction

Independent alien-signals effect parallel to the reply flow. Dual water mark (token estimates use `CHARS_PER_TOKEN = 2` heuristic, not a real tokenizer):

- **High** (`compaction.maxContextEstTokens`, default 200000): trigger when estimated raw content (RC + TRs after cursor, **excluding** the summary itself — otherwise the summary grows until it fills the budget) exceeds this.
- **Low** (`compaction.workingWindowEstTokens`, default 8000): post-compaction working window size.

Output: structured plain-text summary, prepended as a synthetic first user message. Storage is append-only in `compactions` (latest by `ORDER BY id DESC LIMIT 1`); never upsert. Compaction is **not** a TR — separate table, no provider format. `cursorMs` is a `computed()` signal; pipeline auto-applies via `setCompactCursor()`.

### Probe / activate gate

In group chats, run a small `probe.model` first when the bot wasn't recently mentioned/replied to (`lastMentionedAtMs <= lastTrTimeMs`). Probe = single LLM call, no tool execution. No tool calls → bot stays silent; has tool calls → discard probe, activate primary model with same context.

Probe responses go in `probe_responses` (dedicated table). They **never** enter `composeContext` — debug/analysis only.

### Media-to-text transforms

Three blocking ingress transforms (image / animation / custom-emoji), all sharing the `image_alt_texts` table (generic hash → alt text).

- **Image**: cache key = sha256 of the deterministic thumbnail WebP. LLM input = PNG resized to ≤512px long edge. Rendering emits `<image>alt</image>` when alt is present.
- **Animation** (GIF/MP4, video sticker WEBM, animated sticker TGS): cache key = sha256 of file bytes (`animationHash` persisted on the attachment). Frame selection is count-based (≤maxFrames → all; > → equidistant including first/last). TGS detected by gzip magic bytes (don't rely on attachment flags — they may be missing during backfill). Files >20MB skipped. Rendering tags: `<animation type="...">` / `<sticker pack="...">`.
- **Custom emoji**: cache key = `emoji:${customEmojiId}`. Resolved via gramjs `messages.GetCustomEmojiDocuments` batch through the bot client. Alt text set transiently on `ContentNode.altText` — never persisted to `events`. Rendering tag: `<custom-emoji pack="...">`. Without alt: render fallback emoji char.

Alt text is **always** queried transiently from `image_alt_texts` — never stored in `events`. Cold start: sync lookup for cached, async backfill for missing.

Content-aware (MSE-based) frame selection was explored and deferred — see `docs/content-aware-frame-selection.md`.

### HTTP credential redaction

`registerHttpSecret(secret)` in `src/http.ts` masks the string in all `HttpError` messages. Bot token registered at client creation.

### Anti-injection

Identity (who said what) is carried as XML attributes, never inline text. Users can't spoof attributes.

### Debug dumps

Driver writes full LLM request JSON to `/tmp/cahciua/<chatId>.request.json` before each call. Intentional — project is not production-deployed. Don't flag.

## Conventions

- **Functional**: `const` + arrow functions, closure factories. Classes only when required by library APIs or for `Error` subclasses.
- **Strict types**: avoid `any`; `unknown` + narrow. `noUncheckedIndexedAccess` is on. `import type` for type-only imports (lint-enforced).
- **File names**: `kebab-case`.
- **Logging**: `@guiiai/logg` only. `console.log` is reserved for CLI scripts that print copy-paste output.
- **Comments**: only the non-obvious "why" (workarounds, edge cases, decisions). No file-header JSDoc, no field-restating JSDoc, no comments that paraphrase the code.
- **No speculative code**: leave a `// TODO:` instead of a wrong placeholder.
- **Error handling**: let errors propagate. No silent `catch` returning empty/default values, no `??` fallbacks for data without default semantics. See global CLAUDE.md "杜绝假鲁棒".
- **Styling** (ESLint-enforced): 2-space indent, single quotes, semicolons, trailing commas multiline, `1tbs` braces, arrow parens as-needed, Unix line endings.

## Testing

Vitest, files next to source as `*.test.ts`. Projection reducers tested with static fixtures. Driver, persistence, telegram integration are the complexity hotspots — expand coverage when behavior changes. Add a regression test when fixing a bug.

## Dependencies

`pnpm add [-D] <dep>`. Don't hand-edit `package.json`. Run `pnpm typecheck` and `pnpm lint:fix` after finishing a task.

## Data migration

When existing data doesn't match the current design, fix it with a Drizzle migration (SQL UPDATE in a new migration file). **No** runtime fallbacks or compat shims for old data shapes — code handles the latest design only.

## Commits

Conventional Commits (`feat:`, `fix:`, `refactor:`, ...). Focused, scoped. Update this file in the same commit when changing key patterns or invariants.

**NEVER commit or push without explicit human instruction.** Wait for the user to verify and ask.
