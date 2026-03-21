# DCP Design Decisions

## Terminology

| Term | Definition |
|------|-----------|
| **Session** | One instance of the full pipeline: Adaptation → Projection → Rendering → Driver. Each chat has its own Session. |
| **IC** (IntermediateContext) | Structured representation of chat events, produced by Projection. |
| **RC** (RenderedContext) | Serialized, segmented output of Rendering. Provider-agnostic XML. |
| **TR** (TurnResponse) | One entry in the Driver's conversation history, timestamped by `requestedAtMs`. Stores only LLM outputs (assistant responses) and tool results — NOT user messages from RC (those are re-derivable from IC). |
| **Strategy** | A behavioral choice within a layer that determines output quality (rendering format, batching timing, compaction policy, etc.). Strategies are tunable and graded via fixtures. Distinguished from architecture (pipeline structure, data flow, storage format), which is fixed. |

## Theoretical Model

### Events as External Input
The events table is the system's external input layer. Currently it stores IM platform events (`CanonicalIMEvent`), but the architecture is extensible to other input modalities (web browsing results, RSS feeds, etc.) via new event type families. This is a theoretical direction — we don't design or implement non-IM event types now.

### Pipeline: Events → IC → RC, plus TRs
```
events ──→ Projection ──→ IC (always current)
                            │
                      Driver [scheduling]
                            ↓
                      Rendering ──→ RC
                                     \
                                      Driver merges ──→ LLM API call
                                     /
                            TRs (Driver storage)
```
NOTE: Current scheduling is immediate — no debounce. See §Event Processing and Batching.

- `IC' = reduce(IC, CanonicalIMEvent)` — Projection runs immediately on every event. IC is always current.
- `RC = render(IC)` — pure function, triggered by Driver scheduling. IC nodes and RC segments carry `receivedAtMs` from their source events.
- Driver merges RC + TRs by timestamp (`receivedAtMs` / `requestedAtMs`) → final LLM API context array. One merge = one LLM API call.
- Scheduling is owned by the Driver. Currently immediate (no debounce). Its parameters (timing, thresholds) are strategy, not architecture.

In the theoretical model, IC and RC are unbounded sequences. No SessionState, no compact cursor — those are practical concerns (see below).

### RC and TRs Are Orthogonal
RC contains only LLM **input** (serialized chat context). TRs contain only LLM **output** + tool results. LLM APIs are stateless — they don't assign IDs to our user/system messages, so RC needs no provider-specific metadata. All provider complexity lives in TRs.

Both streams carry timestamps for merge ordering: IC nodes carry `receivedAtMs` (milliseconds, from their source events), which flows through to RC segments. TRs carry `requestedAtMs` (milliseconds, set at API request time). The Driver merges these two sorted streams by their respective timestamps. Causality guarantees `receivedAtMs_batch_n < requestedAtMs_n < receivedAtMs_batch_n+1`.

Rendering does not need to know about TR positions — it serializes IC nodes sequentially, each carrying its own `receivedAtMs`. The Driver groups consecutive RC segments between TRs into user messages during merge.

### Timestamp Race Condition Between RC and TRs
During online operation, `receivedAtMs` and `requestedAtMs` are assigned sequentially by `Date.now()`, so ordering is correct. However, when timestamps collide (same millisecond — unlikely but possible), the merge order becomes ambiguous.

This requires a **mandatory tiebreaker**: when `receivedAtMs` equals `requestedAtMs`, RC segments MUST be ordered before TRs. Without this:
- **Anthropic**: Messages API requires strict user/assistant role alternation. If a TR (assistant) is ordered before its preceding RC batch (user), two consecutive assistant messages appear, and the API rejects the request.
- **OpenAI**: No strict alternation requirement, but wrong ordering would still produce a semantically incorrect conversation.
- **Thinking signatures**: Anthropic's thinking `signature` attests only to the thinking block's own content — it does NOT bind to the conversation prefix. Evidence: Anthropic explicitly allows omitting thinking blocks from prior turns, which changes the prefix without invalidating later signatures. So reordering messages before a thinking block does not cause signature validation failure.

The tiebreaker (RC before TR on equal timestamp) is a correctness requirement, not optional mitigation. IMPLEMENTATION NOTE: the merge comparator must implement this rule, and the comment should explain the Anthropic role alternation constraint.

### What TRs Store
Only data that can't be re-derived from IC:
- **Assistant responses**: LLM output with tool_call IDs, thinking blocks, signatures
- **Tool results**: our responses to tool calls (non-deterministic, can't re-execute)
- **NOT user messages**: those are part of RC, re-renderable from IC at any time

Storage format: raw provider format. See "Conversation History Storage" below.

### Compaction
Compaction exists only in the Driver layer in the theoretical model. It makes the infinite IC/RC/TRs finite in practice. It does NOT change the computation results of earlier layers — it only enables them to be implemented with bounded resources.

The compact cursor T is a **millisecond timestamp in the unified `receivedAtMs`/`requestedAtMs` timeline**. Everything with a timestamp < T — both events (by `receivedAtMs`) and TRs (by `requestedAtMs`) — is covered by the compaction summary.

When compaction happens:
1. Driver decides a cut point T (based on token budget, cache strategy — the specific policy is strategy)
2. Driver generates summary covering everything before T (both RC content and TRs)
3. Driver discards its TRs with `requestedAtMs < T`
4. Driver passes cursor T to Rendering → Rendering skips IC nodes before T → Projection may GC nodes before T
5. Driver prepends summary as a "previously on..." prefix when assembling the final LLM API request

### Cross-Session Interaction (open question, not yet designed)
The system runs multiple Sessions (one per chat). Cross-session awareness (e.g., knowledge from chat A influencing chat B) is desirable for thought continuity but the mechanism is TBD:
- **Driver-level late-binding memory injection**: a separate memory system captures facts across sessions, and the Driver injects relevant ones when assembling the LLM request. Clean separation, no event stream pollution.
- **Cross-session event emission**: Session A emits a derived event into Session B's stream. Richer but introduces internal-event backflow (previously rejected for intra-session use).
- Likely a combination. Not designed or implemented now.

## Architecture vs Strategy

This document describes the **architecture**: pipeline structure, data flow, storage format, layer boundaries. These are fixed design decisions.

Within the architecture, each layer contains **strategies** — specific behavioral choices that determine output quality:

- **Scheduling strategy**: parameters for triggering Rendering + Driver (timing, thresholds — currently immediate with natural batching)
- **Projection strategy**: how the reducer handles each event type, what system events to emit, what IC state to maintain
- **Rendering strategy**: serialization format (XML structure, attributes), what information to include/exclude, how to represent attachments, edits, deletions
- **Compaction strategy**: when to compact, how to generate summaries, what to preserve vs discard
- **Tool strategy**: available tools, invocation semantics, result formatting

Strategies are explored, tuned, and evaluated separately from the architecture. They are graded via **fixture-based testing**: reproducible scenarios with known event sequences and quality expectations. The architecture enables strategy changes without structural refactoring — changing how messages are serialized in Rendering doesn't affect the pipeline's data flow or storage format.

This document does not prescribe specific strategies. It describes the mechanism within which strategies operate.

## Practical Decisions

### Dual Timestamps — Deterministic Ordering
- `receivedAtMs` (milliseconds, on events): local receive time, set by `Date.now()` at adaptation. Source of truth for event ordering. Ensures cold-start replay produces the same sequence as live processing regardless of server clock skew or network reordering.
- `requestedAtMs` (milliseconds, on TRs): set by `Date.now()` when the Driver sends an API request. Together with `receivedAtMs`, forms a total order across all events and TRs in the system.
- `timestampSec` (seconds, on events): server-reported time. Shown to the AI as the message's "time". For delete events (no server time), derived as `Math.floor(receivedAtMs / 1000)`.
- DB ordering: `ORDER BY received_at, id` — receivedAtMs for arrival order, id as tiebreaker for events received in the same millisecond.

### IC: Theoretically Complete, Practically a Working Set
IC is conceptually the complete history of all chat events. In practice, it's the working set after the compact cursor — nodes with `receivedAtMs < T` are GC'd since they'll never be rendered again (replaced by compaction summary). The events table retains complete history for research/audit purposes (but completeness is not a business requirement).

Cold start: load compact cursor T from compactions table → `loadEvents(db, chatId, T)` loads only events with `receivedAtMs >= T` → replay through Projection → rebuild IC. Cost is O(events since last compaction). Reply targets pointing to pre-cursor messages will have no preview/sender snapshot (acceptable — those messages are compacted into the summary). User rename detection begins from the cursor; user map is built from post-cursor events only.

### Rendering Parameters
In the theoretical model, `render(IC) → RC` with no extra parameters. In practice, Rendering needs:
- **Compact cursor**: from Driver, to skip IC nodes before the cursor (viewport filtering)
- **Bot identity**: from Driver, for `mentionsMe` / `repliesToMe` annotations on rendered segments

Compaction summary is NOT a Rendering concern — the Driver prepends the summary at merge time when assembling the final LLM API request. Rendering is unaware of compaction semantics; it only receives a cursor timestamp for filtering.

**Current implementation**: late binding lives in the Driver. `injectLateBindingPrompt()` appends a final synthetic user message containing probe / mention / reply state. Rendering does not receive late-binding data; `RenderParams` only carries the compact cursor and bot identity.

These are all provided by the Driver or computed at call time — there is no persistent "SessionState" entity in the theoretical model. Notably, Rendering does NOT need to know about TR positions — it serializes IC nodes sequentially (each carrying `receivedAtMs`), and the Driver groups RC segments into user messages based on TR `requestedAtMs` timestamps during merge.

### Projection Reducer
- Single `reduce(ic, event)` function, not prematurely split into ContentReducer/MetaReducer
- Split when real meta events exist (UserUpdateEvent, MemberJoinEvent, etc.)
- IC carries everything Rendering needs: content (rich text nodes), forwardInfo, editedAtSec, deleted flag

### Edit/Delete Handling
When Projection processes edit or delete events:
- If the target message exists in current IC → mark it in-place (edit: update content/attachments + set `editedAtSec`; delete: set `deleted: true`)
- If the target message is NOT in current IC (already GC'd) → silently ignore. (NOTE: with IC GC not yet implemented, this path is rarely hit — only when a message was never in IC to begin with.)
- Mirrors real IM behavior: edits and deletes modify the original position, not new timeline entries

Edit and delete events come exclusively from the userbot (gramjs / MTProto). Bot API does not push edit or delete notifications. Without the userbot client, the system would not need to handle edits or deletes at all.

### User State Change Detection (MetaReducer pattern)
Reducer compares `event.sender` against `ic.users` on each message. If displayName or username changed, inserts an `ICSystemEvent` at the current position. Old messages retain their original `sender` — Rendering uses `node.sender` (the name at message time), not the latest from `ic.users`. Gives the LLM temporal awareness of identity changes without dedicated platform events. Core MetaReducer idea — a step within the reducer, not a separate abstraction.

### IC Mutation Semantics and KV Cache

IC mutations fall into two categories with different KV cache properties:

**In-place mutations** (edit, delete): modify existing IC nodes at their original position. Rendering renders the current state of each node. This invalidates the KV cache from the mutation point onward — an edit near the start of the context causes a near-full cache miss. Acceptable because:
- Edit/delete events are infrequent (~5-10% of messages) and usually target recent messages (small cache invalidation range)
- Messages already covered by compaction are not in IC — edits targeting them are silently ignored
- Semantic inconsistency with past TRs (assistant responded to pre-edit content, but context now shows post-edit content) does not block any LLM API and does not break thinking signatures (Anthropic signatures attest only to thinking block content, not the conversation prefix)

**Append-only mutations** (user rename, future: join/leave): insert new system event nodes at the end of IC. Old messages are not modified. Naturally KV-cache friendly — the rendered prefix is unchanged.

Design rule: **metadata changes about entities (users, chat settings) are append-only; content changes to specific messages are in-place with marks.** This keeps the common case (new messages + metadata events) cache-friendly and limits cache invalidation to the uncommon case (edits/deletes).

### Unidirectional Data Flow
Data flows strictly forward. No backflow from Driver to events/Projection:
- Events table: only IM platform events (CanonicalIMEvent)
- IC: only derived from platform events
- Driver: sole owner of TRs, provides parameters to Rendering, assembles final request

Earlier design explored BotTurnEvent as an InternalEvent flowing back through Projection. Rejected: (1) splits bot response across two stores; (2) circular dependency; (3) error amplification across three layers.

### Driver Responsibilities
- Sole owner of TRs (conversation history)
- Merges RC + TRs by timestamp (`receivedAtMs` / `requestedAtMs`) into final API request
- **Owns scheduling**: decides when to trigger Rendering + API call. Currently immediate (no debounce) — lives in Driver (not a separate orchestration layer) because the Driver already manages the reactive scheduling graph (signal/computed/effect)
- Manages tool call loop with interrupt + re-schedule on new external messages (see §Tool Call Loop Interleaving below)
- Standard append-only LLM client with restart consistency
- **Dual provider**: OpenAI Chat Completions (`openai-chat`) and OpenAI Responses API (`responses`), selected per-model via `apiFormat` config
- **Probe gate**: cheap pre-check model decides whether to respond in group chats when not explicitly mentioned
- **Compaction**: dual water mark (trigger at `maxContextTokens`, retain `workingWindowTokens`). Compaction state stored in dedicated `compactions` table (append-only). Compact cursor passed to Rendering for viewport filtering.

### Provider-Specific Metadata (in TRs only)

Two providers are implemented: **OpenAI Chat Completions** (`openai-chat`) and **OpenAI Responses API** (`responses`).

| Provider | Tool call ID | Tool result linkage | Extra metadata | Cache |
|---|---|---|---|---|
| OpenAI Chat Comp | `tool_calls[].id` | `role: "tool"`, `tool_call_id` | — | Auto prefix ≥1024 tokens |
| OpenAI Responses | `function_call.call_id` | `function_call_output.call_id` | reasoning items (`encrypted_content`, `id`) | Stored prefix via `previous_response_id` (not used) |

RC (user/system messages) needs NO provider metadata. `cache_control` annotations are added by Driver at request-assembly time, not persisted.

### Tool Call Loop Interleaving

Each LLM API call within a tool call loop produces its own TR (not the entire loop as one TR). When new external chat messages arrive during a tool loop, the Driver's `checkInterrupt` detects the RC change and breaks the loop. The reactive effect then re-schedules a new LLM call, composing fresh context from the latest RC and all persisted TRs. This is an **interrupt + re-schedule** mechanism — the interrupted loop exits completely, and a new call starts with a fresh step budget, updated system prompt, and re-applied token trimming.

New messages' `receivedAtMs` is always > the previous TR's `requestedAtMs` (causality: the message arrived after the API call was sent), so they naturally sort after the TR in the merge.

```
TR₁(t=1500): [assistant₁, tool_result₁]  ← API call 1 returns, tool executes, result stored in same TR
                                            new messages arrive at t=2200, 2800
                                            checkInterrupt detects → loop breaks
                                            re-schedule triggers new LLM call
TR₂(t=3500): [assistant₂]                ← API call 2 returns (no tool calls)

Merge result:
  [user]      RC(≤1000)                   ← original context
  [assistant]  TR₁.assistant₁             ← tool_call
  [tool]       TR₁.tool_result₁           ← tool result (same TR as the call)
  [user]       RC(2200, 2800)             ← new messages that arrived during tool execution
  [assistant]  TR₂.assistant₂             ← LLM sees new messages, decides next action
```

**TR structure**: each TR stores the assistant response + the tool results executed in that step. TR₁ = `[assistant₁, tool_result₁]` (if assistant₁ made a tool call), TR₂ = `[assistant₂]` (if no tool call). This is append-only: each TR is written once when its API call returns and tools (if any) have been executed.

**Merge rule for tool results**: tool results within a TR are anchored immediately after the assistant message in the same TR. New RC segments (from messages arriving during tool execution) sort after the entire TR by timestamp. This preserves the tool_call → tool_result adjacency required by all LLM APIs.

**Provider-specific detail**: Anthropic requires strict user/assistant alternation. Since tool_result is `role: "user"` and new RC is also `role: "user"`, they must be merged into a single user message (tool_result content blocks + text content blocks). OpenAI has separate `role: "tool"` for tool results, so no merging needed.

### Top-Level Request Fields from Previous Response
All implemented APIs are stateless in headers and URLs — none depend on previous responses. For the request body top-level (outside the messages/input array), no cross-turn state is currently used. OpenAI Responses API has `previous_response_id` but it is not implemented (we don't persist response IDs across turns).

### Conversation History Storage
Store in raw provider format, not a provider-agnostic intermediate format. Rationale: an intermediate format risks losing provider-specific information through normalization (bugs hide in "does the union format cover all providers' semantics?"). Direct storage is simpler:

- **Same provider (common case)**: zero conversion, guaranteed lossless
- **Cross provider**: explicit A→B conversion function, direct structure mapping, independently testable
- **Conversion matrix**: N*(N-1) converters. N=2 → 2 functions, manageable. Implemented lazily as needed.

**Implemented providers**:
- `openai-chat`: Chat Completions format. `TRDataEntry[]` — assistant messages with `tool_calls` + tool role messages with `tool_call_id`.
- `responses`: Responses API format. `ResponseOutputItem[]` — output items (`message`, `function_call`, `reasoning`) + `function_call_output` items.

**Conversion architecture**: `composeContext` always outputs openai-chat format `Message[]` as the lingua franca. Responses format TR data is converted to openai-chat messages via `responsesOutputToMessages` during context composition. If the target API is Responses, the runner converts `Message[]` → `ResponseInputItem[]` via `messagesToResponsesInput` before sending. Reasoning is preserved during same-provider replay (`encrypted_content` ↔ `reasoning_opaque`), stripped on cross-provider replay by `sanitizeReasoningForTR`.

```
TurnResponse {
  requestedAtMs: number            — Date.now() at API request. Forms total order with events' receivedAtMs.
  provider: 'openai-chat' | 'responses'
  data: unknown[]                  — raw provider array entries (assistant message + tool results),
                                     exactly as they'd appear in the request array, unwrapped from
                                     response envelope
  inputTokens: number
  outputTokens: number
  reasoningSignatureCompat?: string — provider compat group for reasoning signature validation
}
```

What `data` contains per provider (the extracted array entries, NOT the full response body):
- **OpenAI Chat Comp**: `[assistantMessage, ...toolMessages]` — `choices[0].message` + `{ role: "tool" }` entries
- **OpenAI Responses**: `[...outputItems, ...functionCallOutputItems]` — output items + `function_call_output` items

### TR Storage

TRs are stored in a `turn_responses` DB table, one row per TR:

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | autoincrement |
| chat_id | TEXT NOT NULL | Session ID (= Telegram chat ID) |
| requested_at | INTEGER NOT NULL | millisecond timestamp, merge ordering key |
| provider | TEXT NOT NULL | `'openai-chat'` or `'responses'` |
| data | TEXT (JSON) NOT NULL | raw provider response entries |
| session_meta | TEXT (JSON) | **deprecated** — no longer used. Compaction state is in `compactions` table. |
| input_tokens | INTEGER NOT NULL | for statistics / cost tracking |
| output_tokens | INTEGER NOT NULL | for statistics / cost tracking |
| reasoning_signature_compat | TEXT DEFAULT '' | provider compat group for reasoning signature validation |

Index: `(chat_id, requested_at)` for loading a session's TRs in order.

Compaction state (cursor + summary) is stored in the `compactions` table (append-only, one row per compaction run). See §Compaction below.

## Other Design Decisions

### Event Processing and Scheduling
Projection runs immediately on every event — IC is always current. The Driver owns scheduling: when triggered, Driver calls `render(IC)` to produce RC, then merges RC + TRs into one LLM API call. **Current implementation**: immediate trigger (no debounce). `setTimeout(0)` exits the synchronous signal graph; the `running` signal provides natural batching — messages arriving during an LLM call accumulate and are processed in the next run. Bot responds via `send_message` tool call (not 1:1 response).

### Multimodal
- Low-res thumbnails (~85 tokens) kept in context — cheaper than text descriptions
- Stickers treated like photos with `[Sticker]` text anchor
- Custom emoji: semantic registry pattern — async visual extraction → text replacement (`[PackName_描述]`)

### Context Format
- XML for input (better attention, CDATA escaping, truncation-resilient)
- JSON for output (tool calls)

### Cold Start
- Load compact cursor T from `compactions` table
- Load TRs with `requested_at >= T`
- Replay events through Projection to rebuild IC
- **Current limitation**: `loadEvents(db, chatId)` replays ALL events, not just those after T. IC GC is not implemented — the cursor only affects Rendering viewport. See §IC: Theoretically Complete for the TODO.
- Optional catch-up: fetch missed messages from Telegram API by comparing DB max messageId with Telegram history

## Implemented Extensions

### Compaction (implemented)

**Dual water mark**: compaction triggers when estimated context tokens exceed `maxContextTokens` (high water mark). After compaction, the working window retains `workingWindowTokens` (low water mark) of recent content.

**Compaction flow**:
1. Driver detects context exceeds `maxContextTokens`
2. `findWorkingWindowCursor` walks backward from newest content, counting both RC and TR tokens, finds the cut point T at `workingWindowTokens`
3. Runs a compaction LLM call with the full pre-compaction context (no send_message tool, only summarize)
4. Stores `CompactionSessionMeta` (summary + cursor) in `compactions` table (append-only, one row per compaction)
5. Advances compact cursor T → Rendering skips IC nodes before T
6. Deletes TRs with `requestedAtMs < T`
7. Subsequent turns: summary prefix + working window

**Storage**: `compactions` table, NOT in TR `session_meta` (which is deprecated). Append-only — rollback by deleting the latest row.

### Reasoning Sanitization

Different providers store reasoning (chain-of-thought) in different fields on assistant messages/output items:

| Provider family | Delta field(s) | Storage |
|---|---|---|
| DeepSeek, xAI, Qwen | `reasoning_content` | Accumulated as `reasoning_content` on assistant message |
| vLLM, Groq, OpenRouter | `reasoning` | Accumulated as `reasoning` on assistant message |
| Anthropic compat endpoints | `reasoning_text` + `reasoning_opaque` | Text + opaque signature on assistant message |
| Anthropic content array | `thinking` blocks in `content[]` | Thinking blocks with `signature` field |
| Responses API | Output items with `type: 'reasoning'` | `encrypted_content` + `id` fields |

**Design principle**: all reasoning fields are persisted raw in TRs, exactly as received from the provider. On replay within the same provider family (matched by `reasoningSignatureCompat`), the entire TR data is replayed unmodified — signatures remain valid.

**Cross-provider sanitization** (`sanitizeReasoningForTR` in `context.ts`): when `reasoningSignatureCompat` doesn't match between the stored TR and the current model:
- **openai-chat**: whitelist approach — reconstruct each assistant entry with only `role`, `content`, `tool_calls`. This implicitly strips all reasoning fields regardless of their field name. Also filters `thinking` blocks from `content[]`.
- **responses**: filter out output items where `type === 'reasoning'`.

None of these reasoning field names are part of the official OpenAI Chat Completions spec. The official OpenAI Responses API uses a different mechanism (reasoning output items). All are provider-specific extensions.

### Reactive Driver Architecture

The Driver uses alien-signals (signal/computed/effect) for reactive scheduling. Per-chat state is modeled as signals:

- `rc: signal<RenderedContext>` — latest RC snapshot, updated by `handleEvent`
- `lastProcessedMs: signal<number>` — timestamp of last TR or probe, updated on persist
- `running: signal<boolean>` — whether a step loop is active
- `failedRc: signal<RenderedContext | null>` — failure latch, cleared on new RC
- `compactionMeta: signal<CompactionSessionMeta | null>` — loaded from DB on scope creation, updated on compaction
- `needsReply: computed` — true when new external messages exist after `lastProcessedMs` (and RC is not the same reference as `failedRc`)

An `effect` watches `needsReply` and `running`: when not running and `needsReply` is true, it immediately schedules a step loop via `setTimeout(0)` (to exit the synchronous signal graph). New events update `rc`, which invalidates `needsReply`, which re-triggers the effect. If a loop is running, `checkInterrupt` detects the RC change and breaks the loop; the effect re-fires after `running(false)`.

```
// Simplified reactive graph (actual code in src/driver/index.ts)
rc(newRC)                    // handleEvent updates signal
  → needsReply recomputes   // computed: latestExternalEventMs(rc, lastProcessedMs) != null
  → effect fires            // schedules setTimeout(0)
  → composeContext + runStepLoop
  → onStepComplete: persistTR, lastProcessedMs(now)
  → running(false)          // effect re-checks for pending events
```

**No debounce**: the effect triggers immediately. Natural batching is achieved through the `running` signal — messages arriving during an active LLM call accumulate in RC, and the next run picks them all up.

**Implementation note**: uses alien-signals (`signal`, `computed`, `effect`) — a minimal reactive primitive library. See `src/driver/index.ts` for the actual implementation.

## Planned Directions

### Planned: Topic Index and Recall Tool

Not yet implemented. The compaction summary is currently unstructured text.

**Future direction**: structured summary with topic index (2-5 bullet points with message ID ranges), plus a `recall_messages` tool that lets the LLM retrieve original rendered messages by ID.

**Open questions**:
- Should the recall tool return rendered XML (same as original context) or raw text?
- How many message IDs should the topic index carry? Too many defeats the purpose.
- Should compaction be proactive (triggered by token budget — current) or lazy (triggered when the LLM hits the window boundary)?

### Cold Start Working-Set Optimization (Done)

`loadEvents(db, chatId, afterMs)` filters events by `received_at >= afterMs`. On cold start, the compaction cursor is passed so only post-cursor events are replayed. IC nodes and user map are built from the working set only. Reply targets to pre-cursor messages have no preview (those messages are in the compaction summary). IC GC is implicit — pre-cursor nodes are never loaded into memory.

Remaining possible enhancement: persist a user map snapshot at compaction time so display names from before the cursor are available for rename detection on the first post-cursor message. Currently, the first appearance of each user after the cursor is treated as "new" (no rename event emitted for the gap).

### Token Estimation Calibration

The current `CHARS_PER_TOKEN = 2` is a hardcoded heuristic. CJK-heavy content has ~1.5 chars/token, English-heavy ~4 chars/token, base64 data URLs have ~4 chars/token. A fixed ratio can over- or under-estimate by 50%+.

**Bootstrap calibration**: on the first LLM call of a session, compare `usage.prompt_tokens` (from the API response) against our estimated token count. Derive `actualCharsPerToken = totalInputChars / prompt_tokens`. Use this calibrated ratio for all subsequent `estimateMessageTokens` calls.

The tokenizer is deterministic for a given model, so one calibration per model is sufficient. If the model changes (config update), the ratio resets and recalibrates on the next call.

**Exponential backoff variant**: if the first call fails due to context-too-long, halve the context window estimate and retry. This handles cold start with a completely unknown model where even the initial estimate might exceed the true limit. Converges in O(log n) retries.

```
calibration state per model:
  charsPerToken: number | null    — null = uncalibrated
  calibratedFromModel: string     — model name for cache invalidation

on first successful response:
  charsPerToken = totalInputChars / usage.prompt_tokens
```
