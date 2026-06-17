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

Node ≥22, TypeScript, pnpm. Telegram: tdl + libtdjson (TDLib) for both bot and userbot — no MTProto-level library, no Bot API HTTP. `prebuilt-tdlib` ships the libtdjson shared library. DB: better-sqlite3 + Drizzle. State: Immer. Reactivity: alien-signals. Validation: Valibot. Prompts: `@velin-dev/core` (all in `prompts/*.velin.md` — never hardcode prompt strings). Logging: `@guiiai/logg`. Tests: Vitest. Media: sharp, ffmpeg-static + ffprobe-static, lottie-frame (needs system `libpng-dev` + `librlottie-dev`).

## Commands

`pnpm dev` (watch) / `pnpm start` / `pnpm build` / `pnpm typecheck` / `pnpm lint[:fix]` / `pnpm test[:run]` / `pnpm login` (interactive userbot tdlib login) / `pnpm db:generate` (Drizzle migration) / `pnpm tdlib:build` (escape hatch: build libtdjson from TDLib master into `vendor/` when prebuilt-tdlib lags) / `pnpm tdlib:types` (regenerate TS types from vendor libtdjson).

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

### libtdjson + types resolution

Three pieces work together:

- **`vendor/libtdjson.so`** (gitignored) — locally built TDLib master. Optional; populated by `pnpm tdlib:build`.
- **`prebuilt-tdlib`** (npm dep) — pinned TDLib version, used when no vendor build exists.
- **`types/tdlib-types.d.ts`** (gitignored) — TypeScript types matching whichever libtdjson is active.

Runtime: `src/telegram/tdjson.ts:resolveTdjson()` returns the vendor `.so` if present, else `prebuilt-tdlib`'s. Used by main app, login script, and probe.

Build / types lifecycle (single-responsibility, idempotent):

| Command | Effect |
|---|---|
| `pnpm tdlib:build` | (1) git clone + cmake build of TDLib master → `vendor/libtdjson.so`. Patches in `scripts/tdlib-patches/*.patch` apply via `patch -p1` after the master reset (currently: drop the local-cache guard from `set_message_reactions` so bots can react to messages not currently in TDLib's in-memory map — the downstream MTProto query needs only chat peer + server msg_id). (2) Chains into `pnpm tdlib:types`. |
| `pnpm tdlib:types` | Generates `types/tdlib-types.d.ts` from whichever libtdjson `resolveTdjson()` would pick (vendor → prebuilt fallback). Idempotent. |
| `postinstall` (auto) | `pnpm tdlib:types`. Ensures types match runtime after any `pnpm install`. |

Day-1 flow for a new TDLib feature: `pnpm tdlib:build` → restart app. Day-1 flow for someone using prebuilt only: wait for `prebuilt-tdlib` to publish a newer version + `pnpm install`.

### Two Telegram clients, single ingress source

Both bot and userbot are tdl `Client` instances over libtdjson (TDLib). The bot is sender-only by default; the userbot, when configured, owns ingress (messages, edits, deletes, typing, history, reply-to resolution) because bots have server-enforced visibility limits regardless of protocol — privacy mode hides most group messages, edit/delete updates are unreliable, history is restricted, and other bots' messages are invisible. Without a userbot session the bot client takes over ingress on its own (with all those limitations).

`apiId`/`apiHash` are unconditionally required (the bot also needs MTProto credentials via TDLib); `userbotEnabled` is the flag deciding whether to instantiate a second tdl Client. Each client gets its own tdlib state directory (`botDataDir` / `userbotDataDir`, defaulting to `data/tdlib-bot` and `data/tdlib-userbot`). Bot login is automatic from the token; userbot login is interactive — `pnpm login` writes auth state into the userbot data dir, then the main app reuses that dir.

Downloads go through `telegramManager.downloadMessageMedia(chatId, messageId)` — prefers userbot for full visibility, falls back to bot. tdlib-local file ids are ephemeral; we never store them. Re-fetching is keyed off `(chatId, messageId)`: tdlib's `getMessage` returns the current state with fresh file references, then `downloadFile({ synchronous: true })` blocks until the file lands at `local.path`, which we read into a Buffer.

**Edit/delete come from the active ingress source.** TDLib splits edits into `updateMessageEdited` (edit_date arrived — proves it's a real user edit, not a phantom from link previews / reactions / keyboard refreshes) and `updateMessageContent` (content payload). We listen for `updateMessageEdited` and re-fetch via `getMessage` to get the full new state — the `updateMessageEdited` gating naturally excludes phantoms.

### Markdown → entities

Bot output goes Markdown → Telegram-supported HTML (via `markdown-it` in `src/telegram/markdown.ts`) → `formattedText` (via `tdl.execute({_:'parseTextEntities', parse_mode: textParseModeHTML})`) → `sendMessage`. The HTML→entity conversion is delegated to TDLib's canonical parser, the same one telegram-bot-api uses. Supported subset: `b strong i em u ins s strike del tg-spoiler tg-emoji tg-time span(class=tg-spoiler) pre code blockquote a`. We never hand-roll entity arrays.

### Configured chat residency

`chats` config = in-memory residency whitelist. Unconfigured chats still persist `events` + `messages` (so the historical archive stays complete) but stop before hydration/Projection/Rendering/Driver.

### IC mutation semantics

- **In-place** (edit, delete): mutate existing IC nodes with marks (`editedAtSec`, `deleted: true`). Costs KV cache from that point. Acceptable for infrequent recent edits.
- **Append-only** (rename, future join/leave): insert system event nodes at the tail. Old messages keep their original `sender` field — Rendering uses `node.sender`, not `ic.users`.

Rule: metadata changes about entities → append-only; content changes to specific messages → in-place with marks.

### Sticker pack title

`stickerSetId` carries the canonical pack identifier — under TDLib this is the numeric `set_id` (string-encoded for safety against int53 overflow), historically the slug under the gramjs era. `stickerSetName` carries the resolved human title. `resolvePackTitle` accepts either form: numeric strings go through `getStickerSet({set_id})`, alphanumeric ones through `searchStickerSet({name})`. Cold-start replay normalizes legacy events that stored the slug in `stickerSetName` and writes the resolved title back to `events`.

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

Mandatory two-step pipeline: every reply turn first runs **probe** (an outside-judge LLM call), and only proceeds to **primary** (the bot itself) when probe judges `should_act = "send_message"`.

Probe and primary share `prompts/system.velin.md` and `prompts/late-binding.velin.md` via a `mode: 'primary' | 'probe'` prop:

- **Probe mode** frames the model as a third-party judge with knowledge of the bot's identity (systemFiles are relabeled as background on the bot). It receives a single tool, `decide(should_act, reason)`, and the tool call args ARE the probe result. `should_act` is a string enum: `"send_message"` (the wake-up should happen and the bot MUST end up calling `send_message` at least once) or `"no_action"` (the wake-up should not happen at all — no message, no reaction, no tool call). There is no third "react only" option: a wake-up that would only react and never message maps to `"no_action"`. Anything else the model emits is discarded. Reason language is unconstrained.
- **Primary mode** is the bot in first person. The system prompt opens by stating an outside evaluator has already judged this wake-up calls for at least one message, and hard-requires that the wake-up end with ≥1 `send_message` call. Other tool calls (`react`, `web_search`, `bash`, …) are free to chain before it across multiple turns — the requirement is on the wake-up as a whole, not each individual turn. There is no `stay_silent` tool. The primary's `forceToolCall` config still applies and is independent of probe's.

Probe is **skipped** only when the previous tool loop was interrupted — that means the bot was mid-reply and got cut off by new user input, so re-entering the reply flow is clearly warranted. Everything else, including `@mentions` and direct replies to the bot, goes through probe; an `@` or reply can also be someone closing an exchange ("ok thanks bot", "晚安"), and the judge decides whether the wake-up actually calls for a message. Runtime events (background task completion) also go through probe.

If probe fails to emit a valid `decide` call (e.g. model didn't call the tool despite forceToolCall), the gate fails closed: treated as `"no_action"`, primary does not run.

Probe responses are stored in `probe_responses_v2` (dedicated table). The `isActivated` column mirrors `should_act === "send_message"`. The `reason` (and the enum value itself) lives inside the persisted `entries` JSON (the decide tool call's args) — no separate column. Probe responses **never** enter `composeContext` — debug/analysis only.

### Media-to-text transforms

Three blocking ingress transforms (image / animation / custom-emoji), all sharing the `image_alt_texts` table (generic hash → alt text).

- **Image**: cache key = sha256 of the deterministic thumbnail WebP. LLM input = PNG resized to ≤512px long edge. Rendering emits `<image>alt</image>` when alt is present.
- **Animation** (GIF/MP4, video sticker WEBM, animated sticker TGS): cache key = sha256 of file bytes (`animationHash` persisted on the attachment). Frame selection is count-based (≤maxFrames → all; > → equidistant including first/last). TGS detected by gzip magic bytes (don't rely on attachment flags — they may be missing during backfill). Files >20MB skipped. Rendering tags: `<animation type="...">` / `<sticker pack="...">`.
- **Custom emoji**: cache key = `emoji:${customEmojiId}`. Resolved via TDLib `getCustomEmojiStickers` through the bot client. Alt text set transiently on `ContentNode.altText` — never persisted to `events`. Rendering tag: `<custom-emoji pack="...">`. Without alt: render fallback emoji char.

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

## Backporting from downstream

We routinely port commits from the downstream fork `chiyuki0325/Edelweiss` (git remote `edelweiss`). Conventions for these ports:

**Author vs co-author** — depends on how much of the work is genuinely theirs:

- **Faithful port** (idea + implementation both come from downstream, our changes are just architectural adaptation / lint / variable rename): `author = original author`, `co-author = Menci`. The original author's commit really did create this code; we just integrated it.
- **Reimplementation** (idea from downstream but we rewrote on our own architecture — e.g. declarative signal-based debounce vs their imperative timer): `author = Menci`, `co-author = original author`. Credit the idea, take authorship of the implementation.
- **Pure bug fix written from scratch** (no downstream involvement): `author = Menci`, no co-author.
- **Our work that downstream cherry-picked back from us**: nothing special — already in our history.

**Trailers** — strip AI co-author lines. Per the global rule, never carry `Co-Authored-By: <AI model>` trailers (GPT, DeepSeek, Claude, etc.). Keep human trailers.

**Attribution line** — for faithful ports, add `(cherry picked from commit <full-sha> of chiyuki0325/Edelweiss)` in the message body. For reimplementations, mention the upstream commit in prose ("the concept comes from Edelweiss; the implementation is ours") since the code isn't actually cherry-picked.

**Dates** — preserve the upstream's `GIT_AUTHOR_DATE` for faithful ports (the work really was authored then by that person). Let `GIT_COMMITTER_DATE` default to now (it reflects when the commit landed in this repo). For reimplementations, both dates default to now (we authored it now).

**What to NOT port** — judge per-feature, not by default:

- Downstream-specific persona content (their bot's identity).
- Debug-only scripts / docs that reference their infrastructure.
- Changes that conflict with our architecture (e.g. streaming adapters — we're deliberately non-streaming).
- Things we already have (deduplicate; compare implementations).

**Workflow** — `git cherry-pick -x` for clean ports; resolve conflicts (often: ours wins for files we've diverged on, theirs wins for files they're the source of truth for); `--continue` doesn't accept `-x` so finalize with a manual `git commit` that sets the right author + scrubbed message + dates; verify `pnpm typecheck && pnpm lint && pnpm test:run` before each commit; never `git commit -am` when uncommitted unrelated changes sit in the tree (it'll sweep them in — happened once, had to split).

