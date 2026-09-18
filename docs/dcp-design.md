# Deterministic Context Pipeline

## Purpose

Cahciua does not treat an LLM transcript as authoritative application state. It stores platform events and Driver turn responses, then deterministically reconstructs model context through four ownership layers.

This design provides replayability, explicit side-effect boundaries, provider portability, and stable prompt prefixes for KV caching.

## Data Flow

```text
Telegram update
  -> Telegram adaptation
  -> CanonicalIMEvent
  -> Projection reducer
  -> IntermediateContext (IC)
  -> Rendering
  -> RenderedContext segments (RC)

RC + Driver TurnResponses
  -> timestamp merge
  -> ConversationEntry[]
  -> request-local optimization
  -> provider wire codec
  -> non-streaming LLM request
```

Data moves forward. Projection does not read Driver state. Driver does not write synthetic assistant output into IC. Late-bound data is appended to the request as a synthetic user message.

## Adaptation

Canonical types live in `src/adaptation/types.ts`. Telegram's mapper lives in `src/telegram/adaptation.ts`; this keeps platform decoding next to Telegram while preserving canonical ownership outside the platform module.

Canonical IDs are strings. Every event carries:

- `receivedAtMs`: local ingress time captured before asynchronous transforms.
- `timestampSec`: Telegram server time.
- `utcOffsetMin`: ingress-local timezone offset.

`receivedAtMs` is the ordering timestamp. Persistence uses `(received_at, id)` as a deterministic tie-break.

Media descriptions are resolved before adaptation admits an event. Raw TDLib updates capture ingress metadata before any await; metadata resolution and media work happen in the ordered manager queue. The queue can transform later events in parallel but commits only the contiguous ready prefix. Transform or commit failures retry and block the session rather than publishing incomplete context.

## Projection

Projection is a pure Immer-backed reducer:

```text
reduce(IC, CanonicalIMEvent) -> IC'
```

Message content edits and deletes mutate their existing nodes. Entity metadata changes append system-event nodes. Message-ID deduplication preserves the synthetic `isSelfSent` marker while replacing synthetic content and attachments with the authoritative userbot echo.

Projection never performs I/O and never receives LLM output.

## Rendering

Rendering converts IC into ordered RC segments. Each segment retains `receivedAtMs` and metadata used by scheduling (`senderId`, `isMyself`, `isSelfSent`, mention/reply flags).

User-controlled identity is encoded in XML attributes. Content is escaped and cannot inject sibling message attributes. Attachments expose stable logical file IDs in `messageId:index` form; TDLib-local IDs are not persisted.

Configured blocked senders are masked at render time. Their source events remain in persistence and IC so changing configuration can restore them after replay.

## Driver Context

Turn responses persist provider-independent `ConversationEntry[]` plus:

```text
requestedAtMs
modelName
inputTokens
outputTokens
cacheReadTokens
cacheWriteTokens
```

RC and turn responses are sorted independently and merged by timestamp. RC precedes TR at equal timestamps, which preserves causality and satisfies Anthropic role alternation.

`composeContext()` performs deterministic history optimization:

- remove old pure-text assistant turns beyond the newest five;
- remove RC copies of `isSelfSent` messages represented by send tool calls;
- lower old tool-result image detail and trim old oversized tool-result text;
- sanitize reasoning when stored model identity is incompatible;
- sanitize provider-sensitive tool IDs at the wire boundary;
- prepend the latest compaction summary.

The existing summary does not contribute to the raw compaction trigger estimate.

## Provider Boundary

`src/llm/call.ts` accepts `ConversationEntry[]` and dispatches to one of three non-streaming transports:

- `src/llm/chat.ts`
- `src/llm/messages.ts`
- `src/llm/responses.ts`

`src/unified-api/` converts between IR and wire objects. Provider-specific reasoning/signature data remains attached to IR output nodes. Request-local image limiting happens before every codec invocation, including probes, fallback turns, compaction, and media/tool-generated images.

Usage is normalized at this boundary. OpenAI input totals already include cache hits. Anthropic reports uncached input separately, so cache reads and writes are added to produce total `inputTokens`.

Request and response JSON is written to `/tmp/cahciua/<id>.*.json` for debugging.

## Wake-Up Scheduling

Each configured chat owns a scheduler controller built on alien-signals.

The scheduler computes reply eligibility from:

- unprocessed external RC segments;
- continuation of an interrupted tool loop;
- the last failed RC identity;
- current running state.

Debounce is sender-aware. The message that opens a window identifies the trigger sender; only later messages from that sender move the message deadline. Typing from any observed user moves the typing deadline. `maxDelayMs` is a hard cap from window creation.

Calls are serialized. New input does not preempt a model call, tool side effect, or persistence. The turn loop checks interruption only after the completed step has been persisted, then exits cooperatively. The reactive scheduler creates a new wake-up with current RC.

## Probe And Primary

A wake-up normally has two phases:

1. **Probe** is an outside judge. It receives one forced tool, `decide`.
2. **Primary** runs only when `should_act` is `send_message`.

`should_act=no_action`, missing calls, invalid JSON, invalid enum values, and missing reasons all fail closed. Probe responses are persisted separately and advance the processed watermark, but never enter primary context.

The only probe bypass is continuation of a persisted interrupted tool loop. Mentions, direct replies, and runtime events still use probe.

Primary may execute multiple tools over multiple steps. `send_message.still_working=true` marks a send whose wake-up still requires another step. Other tool results also carry `requiresFollowUp`.

An activated wake-up must contain a successful `send_message`. If a clean `end_turn` closes the current interruption chain without any send, Driver runs one additional step with named `send_message` tool choice. The fallback uses the same prompt and starting context.

## Runner And Turn Loop

Runner has two operations:

```text
callModelStep(entries) -> model entries + usage
executeToolStep(model entries) -> model entries + tool results
```

Providers may ignore forced tool choice. Runner retries up to three times after the first attempt, accumulates usage from rejected attempts, and executes only the selected/final output.

The shared turn loop then:

1. calls the model;
2. executes tool calls sequentially;
3. persists the completed step;
4. terminates if no tool requires follow-up;
5. checks external interruption;
6. appends the step to working entries and continues.

No AbortController is used for chat interruption. Provider request timeouts remain local to the provider transports.

## Compaction

Compaction is an independent per-chat controller parallel to reply scheduling.

- High water mark: `maxContextEstTokens` over raw RC + TR content after the cursor.
- Low water mark: `workingWindowEstTokens`, used to choose the new cursor.

The selected old window is summarized into structured plain text. A new row is appended to `compactions`, then the compaction signal updates Pipeline's render cursor. Compaction is not a turn response and never deletes historical events or TR rows.

## Telegram Runtime

Telegram uses two possible TDLib clients:

- Bot: required, owns all outbound actions.
- Userbot: optional, exclusively owns ingress when configured.

The manager owns raw clients, ordered ingress, and blocking transforms. Live handlers preserve side-effect order:

```text
persist platform message/edit/delete row
-> persist canonical event
-> if configured: hydrate cached alt text
-> project/render
-> notify DriverInputBus
```

The queue retries the same commit object on persistence/publication failure; live handlers and the event sink make each phase idempotent. Unconfigured chats stop after persistence.

Driver hooks own outbound sends. After Telegram confirms a send (the terminal `updateMessageSendSucceeded`/`updateMessageSendFailed` that also carries the final server message id), they create and persist a synthetic `isSelfSent` event, project it for configured chats, and deliberately do not notify Driver. This makes the bot's action visible to the next probe before userbot echo, and its message id makes the echo deduplication in Projection an exact match.

Post-startup tasks backfill missing animation hashes and uncached custom emoji, then replay affected resident chats.

## Media Runtime

Media processing is platform-neutral and lives in `src/media/`. The runtime builds resolver maps from each resolved chat config, so model, concurrency, and frame overrides apply per chat while content-addressed cache rows remain shared.

Image descriptions use deterministic thumbnail hashes. Animation descriptions use file hashes and equidistant frame selection. Static/animated custom emoji use `emoji:<customEmojiId>` cache keys. All descriptions share `image_alt_texts`.

Cached alt text is applied transiently during replay/live publication. It is never added to persisted canonical event JSON.

## Composition And Lifecycle

`src/container/` is the composition root. Typed symbol tokens are registered through a static registrar list and cached per child container. Registrars are grouped by core configuration, persistence, Telegram clients/manager, media, Pipeline, and Driver/event adapters.

No business factory receives the container. No registrar is discovered from the filesystem. This keeps the dependency graph visible and compatible with the single-entry tsdown bundle.

`DriverInputBus` breaks event-producer/Driver construction cycles. It buffers only the newest RC per chat while attached but inactive. Typing is ephemeral and is ignored before activation.

Startup and shutdown order is documented in `AGENTS.md` and implemented by `src/startup/index.ts`.

## Determinism Boundary

Determinism applies to adaptation, projection, rendering, merge, and request composition for the same stored inputs and parameters. Network responses, local ingress timestamps, scheduling time, tool side effects, and LLM generation are explicitly outside that pure boundary. Their results are persisted before they influence subsequent reconstruction.
