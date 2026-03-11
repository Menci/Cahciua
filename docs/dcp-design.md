# DCP Design Decisions

## Terminology

| Term | Definition |
|------|-----------|
| **Session** | One instance of the full pipeline: Adaptation → Projection → Rendering → Driver. Each chat has its own Session. |
| **IC** (IntermediateContext) | Structured representation of chat events, produced by Projection. |
| **RC** (RenderedContext) | Serialized, segmented output of Rendering. Provider-agnostic XML. |
| **Turn** | One entry in the Driver's conversation history, timestamped by `requestedAt`. Stores only LLM outputs (assistant responses) and tool results — NOT user messages from RC (those are re-derivable from IC). |
| **Strategy** | A behavioral choice within a layer that determines output quality (rendering format, batching timing, compaction policy, etc.). Strategies are tunable and graded via fixtures. Distinguished from architecture (pipeline structure, data flow, storage format), which is fixed. |

## Theoretical Model

### Events as External Input
The events table is the system's external input layer. Currently it stores IM platform events (`CanonicalIMEvent`), but the architecture is extensible to other input modalities (web browsing results, RSS feeds, etc.) via new event type families. This is a theoretical direction — we don't design or implement non-IM event types now.

### Pipeline: Events → IC → RC, plus Turns
```
events ──→ Projection ──→ IC (always current)
                            │
                      [debounce/throttle]
                            ↓
                      Rendering ──→ RC
                                     \
                                      Driver merges ──→ LLM API call
                                     /
                            Turns (Driver storage)
```

- `IC' = reduce(IC, CanonicalIMEvent)` — Projection runs immediately on every event. IC is always current.
- `RC = render(IC)` — pure function, triggered by debounce/throttle. IC nodes and RC segments carry `receivedAt` from their source events.
- Driver merges RC + Turns by timestamp (`receivedAt` / `requestedAt`) → final LLM API context array. One merge = one LLM API call.
- Debounce/throttle sits between Projection and Rendering. Its parameters are strategy, not architecture.

In the theoretical model, IC and RC are unbounded sequences. No SessionState, no compact cursor — those are practical concerns (see below).

### RC and Turns Are Orthogonal
RC contains only LLM **input** (serialized chat context). Turns contain only LLM **output** + tool results. LLM APIs are stateless — they don't assign IDs to our user/system messages, so RC needs no provider-specific metadata. All provider complexity lives in Turns.

Both streams carry timestamps for merge ordering: IC nodes carry `receivedAt` (milliseconds, from their source events), which flows through to RC segments. Turns carry `requestedAt` (milliseconds, set at API request time). The Driver merges these two sorted streams by their respective timestamps. Causality guarantees `receivedAt_batch_n < requestedAt_n < receivedAt_batch_n+1`.

Rendering does not need to know about Turn positions — it serializes IC nodes sequentially, each carrying its own `receivedAt`. The Driver groups consecutive RC segments between Turns into user messages during merge.

### Timestamp Race Condition Between RC and Turns
During online operation, `receivedAt` and `requestedAt` are assigned sequentially by `Date.now()`, so ordering is correct. However, when timestamps collide (same millisecond — unlikely but possible), the merge order becomes ambiguous.

This requires a **mandatory tiebreaker**: when `receivedAt` equals `requestedAt`, RC segments MUST be ordered before Turns. Without this:
- **Anthropic**: Messages API requires strict user/assistant role alternation. If a Turn (assistant) is ordered before its preceding RC batch (user), two consecutive assistant messages appear, and the API rejects the request.
- **OpenAI**: No strict alternation requirement, but wrong ordering would still produce a semantically incorrect conversation.
- **Thinking signatures**: Anthropic's thinking `signature` attests only to the thinking block's own content — it does NOT bind to the conversation prefix. Evidence: Anthropic explicitly allows omitting thinking blocks from prior turns, which changes the prefix without invalidating later signatures. So reordering messages before a thinking block does not cause signature validation failure.

The tiebreaker (RC before Turn on equal timestamp) is a correctness requirement, not optional mitigation. IMPLEMENTATION NOTE: the merge comparator must implement this rule, and the comment should explain the Anthropic role alternation constraint.

### What Turns Store
Only data that can't be re-derived from IC:
- **Assistant responses**: LLM output with tool_call IDs, thinking blocks, signatures
- **Tool results**: our responses to tool calls (non-deterministic, can't re-execute)
- **NOT user messages**: those are part of RC, re-renderable from IC at any time

Storage format: raw provider format. See "Conversation History Storage" below.

### Compaction
Compaction exists only in the Driver layer in the theoretical model. It makes the infinite IC/RC/Turns finite in practice. It does NOT change the computation results of earlier layers — it only enables them to be implemented with bounded resources.

The compact cursor T is a **millisecond timestamp in the unified `receivedAt`/`requestedAt` timeline**. Everything with a timestamp < T — both events (by `receivedAt`) and Turns (by `requestedAt`) — is covered by the compaction summary.

When compaction happens:
1. Driver decides a cut point T (based on token budget, cache strategy — the specific policy is strategy)
2. Driver generates summary covering everything before T (both RC content and Turns)
3. Driver discards its Turns with `requestedAt < T`
4. Driver passes cursor T to Rendering → Rendering skips IC nodes before T → Projection may GC nodes before T
5. Summary is included in RC output as a "previously on..." prefix

### Cross-Session Interaction (open question, not yet designed)
The system runs multiple Sessions (one per chat). Cross-session awareness (e.g., knowledge from chat A influencing chat B) is desirable for thought continuity but the mechanism is TBD:
- **Late-binding memory injection**: a separate memory system captures facts across sessions, injects relevant ones at rendering time. Clean separation, no event stream pollution.
- **Cross-session event emission**: Session A emits a derived event into Session B's stream. Richer but introduces internal-event backflow (previously rejected for intra-session use).
- Likely a combination. Not designed or implemented now.

## Architecture vs Strategy

This document describes the **architecture**: pipeline structure, data flow, storage format, layer boundaries. These are fixed design decisions.

Within the architecture, each layer contains **strategies** — specific behavioral choices that determine output quality:

- **Batching strategy**: debounce/throttle parameters for triggering Rendering + Driver (timing, thresholds)
- **Projection strategy**: how the reducer handles each event type, what system events to emit, what IC state to maintain
- **Rendering strategy**: serialization format (XML structure, attributes), what information to include/exclude, how to represent attachments, edits, deletions
- **Compaction strategy**: when to compact, how to generate summaries, what to preserve vs discard
- **Tool strategy**: available tools, invocation semantics, result formatting

Strategies are explored, tuned, and evaluated separately from the architecture. They are graded via **fixture-based testing**: reproducible scenarios with known event sequences and quality expectations. The architecture enables strategy changes without structural refactoring — changing how messages are serialized in Rendering doesn't affect the pipeline's data flow or storage format.

This document does not prescribe specific strategies. It describes the mechanism within which strategies operate.

## Practical Decisions

### Dual Timestamps — Deterministic Ordering
- `receivedAt` (milliseconds, on events): local receive time, set by `Date.now()` at adaptation. Source of truth for event ordering. Ensures cold-start replay produces the same sequence as live processing regardless of server clock skew or network reordering.
- `requestedAt` (milliseconds, on Turns): set by `Date.now()` when the Driver sends an API request. Together with `receivedAt`, forms a total order across all events and Turns in the system.
- `timestamp` (seconds, on events): server-reported time. Shown to the AI as the message's "time". For delete events (no server time), derived as `Math.floor(receivedAt / 1000)`.
- DB ordering: `ORDER BY received_at, id` — receivedAt for arrival order, id as tiebreaker for events received in the same millisecond.

### IC: Theoretically Complete, Practically a Working Set
IC is conceptually the complete history of all chat events. In practice, it's the working set after the compact cursor — nodes with `receivedAt < T` are GC'd since they'll never be rendered again (replaced by compaction summary). The events table retains complete history for research/audit purposes (but completeness is not a business requirement).

Cold start: load compact cursor T from Driver storage → load Turns with `requestedAt >= T` → replay events with `receivedAt >= T` through Projection → rebuild IC working set. O(events since last compaction), not O(all events ever).

### Rendering Parameters
In the theoretical model, `render(IC) → RC` with no extra parameters. In practice, Rendering needs:
- **Compact cursor + summary**: from Driver, to truncate IC and prepend summary
- **System prompt**: configuration
- **Late-binding context**: computed at request time (recalled memory, cross-session awareness)

These are all provided by the Driver or computed at call time — there is no persistent "SessionState" entity in the theoretical model. Notably, Rendering does NOT need to know about Turn positions — it serializes IC nodes sequentially (each carrying `receivedAt`), and the Driver groups RC segments into user messages based on Turn `requestedAt` timestamps during merge.

### Projection Reducer
- Single `reduce(ic, event)` function, not prematurely split into ContentReducer/MetaReducer
- Split when real meta events exist (UserUpdateEvent, MemberJoinEvent, etc.)
- IC carries everything Rendering needs: entities, forwardInfo, editedAt, deleted flag

### Edit/Delete Handling
When Projection processes edit or delete events:
- If the target message exists in current IC → mark it in-place (edit: update text/entities/attachments + set `editedAt`; delete: set `deleted: true`)
- If the target message is NOT in current IC (already GC'd) → silently ignore
- Mirrors real IM behavior: edits and deletes modify the original position, not new timeline entries

### User State Change Detection (MetaReducer pattern)
Reducer compares `event.sender` against `ic.users` on each message. If displayName or username changed, inserts an `ICSystemEvent` at the current position. Gives the LLM temporal awareness of identity changes without dedicated platform events. Core MetaReducer idea — a step within the reducer, not a separate abstraction.

### Unidirectional Data Flow
Data flows strictly forward. No backflow from Driver to events/Projection:
- Events table: only IM platform events (CanonicalIMEvent)
- IC: only derived from platform events
- Driver: sole owner of Turns, provides parameters to Rendering, assembles final request

Earlier design explored BotTurnEvent as an InternalEvent flowing back through Projection. Rejected: (1) splits bot turn across two stores; (2) circular dependency; (3) error amplification across three layers.

### Driver Responsibilities
- Sole owner of Turns (conversation history)
- Provides compact cursor + summary to Rendering
- Merges RC + Turns by timestamp (`receivedAt` / `requestedAt`) into final API request
- Manages tool call loop (call → execute → result → re-call LLM)
- Provider-specific adapters for serialization/deserialization
- Owns compaction decisions (timing, boundary, summary generation)
- Standard append-only LLM client with restart consistency

### Provider-Specific Metadata (in Turns only)

| Provider | Tool call ID | Tool result linkage | Extra metadata | Cache |
|---|---|---|---|---|
| OpenAI Chat Comp | `tool_calls[].id` | `role: "tool"`, `tool_call_id` | — | Auto prefix ≥1024 tokens |
| Anthropic Messages | `tool_use.id` | `tool_result.tool_use_id` | thinking `signature`, `redacted_thinking.data` | Explicit `cache_control` breakpoints (max 4) |

RC (user/system messages) needs NO provider metadata. `cache_control` annotations are added by Driver at request-assembly time, not persisted.

### Top-Level Request Fields from Previous Response
All three major APIs are stateless in headers and URLs — none depend on previous responses. For the request body top-level (outside the messages/input array), only OpenAI Responses API has a field that comes from the previous response: `response.id` → next request's `previous_response_id`. OpenAI Chat Completions and Anthropic Messages have no such fields.

This is stored in the latest Turn's `sessionMeta`. When constructing the next request, Driver reads the last Turn's `sessionMeta`; if the provider matches, it uses the value. If the provider changed, it ignores it.

### Conversation History Storage
Store in raw provider format, not a provider-agnostic intermediate format. Rationale: an intermediate format risks losing provider-specific information through normalization (bugs hide in "does the union format cover all providers' semantics?"). Direct storage is simpler:

- **Same provider (common case)**: zero conversion, guaranteed lossless
- **Cross provider**: explicit A→B conversion function, direct structure mapping, independently testable
- **Conversion matrix**: N*(N-1) converters. N=2-3 → 2-6 functions, manageable. Implemented lazily as needed.

```
Turn {
  requestedAt: number            — Date.now() at API request. Forms total order with events' receivedAt.
  provider: string               — 'openai-chat' | 'anthropic-messages' | 'openai-responses'
  data: unknown                  — raw provider array entries (assistant message + tool results),
                                   exactly as they'd appear in the request array, unwrapped from
                                   response envelope
  sessionMeta?: unknown          — top-level state from response (e.g. response.id for Responses API)
}
```

What `data` contains per provider (the extracted array entries, NOT the full response body):
- **OpenAI Chat Comp**: `[assistantMessage, ...toolMessages]` — `choices[0].message` + `{ role: "tool" }` entries
- **Anthropic Messages**: `[assistantMessage, toolResultUserMessage]` — `{ role: "assistant", content }` + `{ role: "user", content: [tool_result, ...] }`
- **OpenAI Responses**: `[...outputItems, ...functionCallOutputItems]` — output items + `function_call_output` items

### Turn Storage

Turns are stored in a `turns` DB table, one row per Turn:

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | autoincrement |
| session_id | TEXT NOT NULL | Session ID (= Telegram chat ID) |
| requested_at | INTEGER NOT NULL | millisecond timestamp, merge ordering key |
| provider | TEXT NOT NULL | e.g. 'openai-chat', 'anthropic-messages' |
| data | TEXT (JSON) NOT NULL | raw provider response entries |
| session_meta | TEXT (JSON) | top-level state from response |
| input_tokens | INTEGER NOT NULL | for statistics / cost tracking |
| output_tokens | INTEGER NOT NULL | for statistics / cost tracking |
| response_envelope | TEXT (JSON) | raw response with content/output stripped (already in `data`). Includes model, finish_reason, usage, system_fingerprint, etc. |

Index: `(session_id, requested_at)` for loading a session's Turns in order.

Compaction state (cursor + summary) is session-level, not per-Turn. Stored separately — either in a dedicated session-state table or as metadata on the oldest remaining Turn after GC. Exact mechanism TBD when implementing compaction.

## Other Design Decisions

### Event Processing and Batching
Projection runs immediately on every event — IC is always current. Rendering + Driver invocation is debounce/throttled — RC is produced in batches. Each batch triggers one Driver invocation = one LLM API call. The debounce/throttle parameters (timing, thresholds) are strategy. Bot responds via `send_message` tool call (not 1:1 response).

### Multimodal
- Low-res thumbnails (~85 tokens) kept in context — cheaper than text descriptions
- Stickers treated like photos with `[Sticker]` text anchor
- Custom emoji: semantic registry pattern — async visual extraction → text replacement (`[PackName_描述]`)

### Context Format
- XML for input (better attention, CDATA escaping, truncation-resilient)
- JSON for output (tool calls)

### Cold Start
- Load compact cursor T from turns table (or session-state storage)
- Load Turns with `requested_at >= T`
- Replay events with `received_at >= T` through Projection to rebuild IC
- Optional catch-up: fetch missed messages from Telegram API by comparing DB max messageId with Telegram history
