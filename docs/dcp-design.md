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
                      Driver [debounce/throttle]
                            ↓
                      Rendering ──→ RC
                                     \
                                      Driver merges ──→ LLM API call
                                     /
                            TRs (Driver storage)
```

- `IC' = reduce(IC, CanonicalIMEvent)` — Projection runs immediately on every event. IC is always current.
- `RC = render(IC)` — pure function, triggered by debounce/throttle. IC nodes and RC segments carry `receivedAtMs` from their source events.
- Driver merges RC + TRs by timestamp (`receivedAtMs` / `requestedAtMs`) → final LLM API context array. One merge = one LLM API call.
- Debounce/throttle is owned by the Driver. Its parameters (timing, thresholds) are strategy, not architecture.

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
- `receivedAtMs` (milliseconds, on events): local receive time, set by `Date.now()` at adaptation. Source of truth for event ordering. Ensures cold-start replay produces the same sequence as live processing regardless of server clock skew or network reordering.
- `requestedAtMs` (milliseconds, on TRs): set by `Date.now()` when the Driver sends an API request. Together with `receivedAtMs`, forms a total order across all events and TRs in the system.
- `timestampSec` (seconds, on events): server-reported time. Shown to the AI as the message's "time". For delete events (no server time), derived as `Math.floor(receivedAtMs / 1000)`.
- DB ordering: `ORDER BY received_at, id` — receivedAtMs for arrival order, id as tiebreaker for events received in the same millisecond.

### IC: Theoretically Complete, Practically a Working Set
IC is conceptually the complete history of all chat events. In practice, it's the working set after the compact cursor — nodes with `receivedAtMs < T` are GC'd since they'll never be rendered again (replaced by compaction summary). The events table retains complete history for research/audit purposes (but completeness is not a business requirement).

Cold start: load compact cursor T from Driver storage → load TRs with `requestedAtMs >= T` → replay events with `receivedAtMs >= T` through Projection → rebuild IC working set. O(events since last compaction), not O(all events ever).

### Rendering Parameters
In the theoretical model, `render(IC) → RC` with no extra parameters. In practice, Rendering needs:
- **Compact cursor + summary**: from Driver, to truncate IC and prepend summary
- **System prompt**: configuration
- **Late-binding context**: computed at request time (recalled memory, cross-session awareness)

These are all provided by the Driver or computed at call time — there is no persistent "SessionState" entity in the theoretical model. Notably, Rendering does NOT need to know about TR positions — it serializes IC nodes sequentially (each carrying `receivedAtMs`), and the Driver groups RC segments into user messages based on TR `requestedAtMs` timestamps during merge.

### Projection Reducer
- Single `reduce(ic, event)` function, not prematurely split into ContentReducer/MetaReducer
- Split when real meta events exist (UserUpdateEvent, MemberJoinEvent, etc.)
- IC carries everything Rendering needs: content (rich text nodes), forwardInfo, editedAtSec, deleted flag

### Edit/Delete Handling
When Projection processes edit or delete events:
- If the target message exists in current IC → mark it in-place (edit: update content/attachments + set `editedAtSec`; delete: set `deleted: true`)
- If the target message is NOT in current IC (already GC'd) → silently ignore
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
- Provides compact cursor + summary to Rendering
- Merges RC + TRs by timestamp (`receivedAtMs` / `requestedAtMs`) into final API request
- **Owns debounce/throttle scheduling**: decides when to trigger Rendering + API call. Lives in Driver (not a separate orchestration layer) because tool call loops already require the Driver to decide when to re-render — externalizing debounce would create coordination overhead between the scheduler and the active loop.
- Manages tool call loop (see §Tool Call Loop Interleaving below)
- Provider-specific adapters for serialization/deserialization
- Owns compaction decisions (timing, boundary, summary generation)
- Standard append-only LLM client with restart consistency

### Provider-Specific Metadata (in TRs only)

| Provider | Tool call ID | Tool result linkage | Extra metadata | Cache |
|---|---|---|---|---|
| OpenAI Chat Comp | `tool_calls[].id` | `role: "tool"`, `tool_call_id` | — | Auto prefix ≥1024 tokens |
| Anthropic Messages | `tool_use.id` | `tool_result.tool_use_id` | thinking `signature`, `redacted_thinking.data` | Explicit `cache_control` breakpoints (max 4) |

RC (user/system messages) needs NO provider metadata. `cache_control` annotations are added by Driver at request-assembly time, not persisted.

### Tool Call Loop Interleaving

Each LLM API call within a tool call loop produces its own TR (not the entire loop as one TR). This enables **new chat messages to appear mid-loop**: Projection runs immediately on every event, so IC is always current. Before each loop iteration, the Driver re-renders IC. New messages' `receivedAtMs` is always > the previous TR's `requestedAtMs` (causality: the message arrived after the API call was sent), so they naturally sort after the TR in the merge.

```
TR₁(t=1500): [assistant₁(tool_call)]     ← API call 1 returns
                                            tool executes... new messages arrive at t=2200, 2800
TR₂(t=3500): [tool_result₁, assistant₂]  ← API call 2 returns

Merge result:
  [user]      RC(≤1000)                   ← original context
  [assistant]  TR₁(1500)                  ← tool_call
  [tool/user]  TR₂.tool_result₁           ← tool result (anchored after TR₁)
  [user]       RC(2200, 2800)             ← new messages that arrived during tool execution
  [assistant]  TR₂.assistant₂             ← LLM sees new messages, decides next action
```

**TR structure**: each TR stores the tool results that were *sent with* that API call (input) + the assistant response that was *received* (output). TR₁ = `[assistant₁]`, TR₂ = `[tool_result₁, assistant₂]`. This is append-only: each TR is written once when its API call returns.

**Merge rule for tool results**: tool results in a TR are anchored immediately after the previous TR (which contained the tool_call that triggered them), before any interleaved RC segments. This preserves the tool_call → tool_result adjacency required by all LLM APIs.

**Provider-specific detail**: Anthropic requires strict user/assistant alternation. Since tool_result is `role: "user"` and new RC is also `role: "user"`, they must be merged into a single user message (tool_result content blocks + text content blocks). OpenAI has separate `role: "tool"` for tool results, so no merging needed.

### Top-Level Request Fields from Previous Response
All three major APIs are stateless in headers and URLs — none depend on previous responses. For the request body top-level (outside the messages/input array), only OpenAI Responses API has a field that comes from the previous response: `response.id` → next request's `previous_response_id`. OpenAI Chat Completions and Anthropic Messages have no such fields.

This is stored in the latest TR's `sessionMeta`. When constructing the next request, Driver reads the last TR's `sessionMeta`; if the provider matches, it uses the value. If the provider changed, it ignores it.

### Conversation History Storage
Store in raw provider format, not a provider-agnostic intermediate format. Rationale: an intermediate format risks losing provider-specific information through normalization (bugs hide in "does the union format cover all providers' semantics?"). Direct storage is simpler:

- **Same provider (common case)**: zero conversion, guaranteed lossless
- **Cross provider**: explicit A→B conversion function, direct structure mapping, independently testable
- **Conversion matrix**: N*(N-1) converters. N=2-3 → 2-6 functions, manageable. Implemented lazily as needed.

```
TurnResponse {
  requestedAtMs: number            — Date.now() at API request. Forms total order with events' receivedAtMs.
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

### TR Storage

TRs are stored in a `turn_responses` DB table, one row per TR:

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | autoincrement |
| chat_id | TEXT NOT NULL | Session ID (= Telegram chat ID) |
| requested_at | INTEGER NOT NULL | millisecond timestamp, merge ordering key |
| provider | TEXT NOT NULL | e.g. 'openai-chat', 'anthropic-messages' |
| data | TEXT (JSON) NOT NULL | raw provider response entries |
| session_meta | TEXT (JSON) | top-level state from response |
| input_tokens | INTEGER NOT NULL | for statistics / cost tracking |
| output_tokens | INTEGER NOT NULL | for statistics / cost tracking |
| response_envelope | TEXT (JSON) | raw response with content/output stripped (already in `data`). Includes model, finish_reason, usage, system_fingerprint, etc. |

Index: `(chat_id, requested_at)` for loading a session's TRs in order.

Compaction state (cursor + summary) is session-level, not per-TR. Stored separately — either in a dedicated session-state table or as metadata on the oldest remaining TR after GC. Exact mechanism TBD when implementing compaction.

## Other Design Decisions

### Event Processing and Batching
Projection runs immediately on every event — IC is always current. The Driver owns debounce/throttle: when it fires, Driver calls `render(IC)` to produce RC, then merges RC + TRs into one LLM API call. The debounce/throttle parameters (timing, thresholds) are strategy. Bot responds via `send_message` tool call (not 1:1 response).

### Multimodal
- Low-res thumbnails (~85 tokens) kept in context — cheaper than text descriptions
- Stickers treated like photos with `[Sticker]` text anchor
- Custom emoji: semantic registry pattern — async visual extraction → text replacement (`[PackName_描述]`)

### Context Format
- XML for input (better attention, CDATA escaping, truncation-resilient)
- JSON for output (tool calls)

### Cold Start
- Load compact cursor T from turn_responses table (or session-state storage)
- Load TRs with `requested_at >= T`
- Replay events with `received_at >= T` through Projection to rebuild IC
- Optional catch-up: fetch missed messages from Telegram API by comparing DB max messageId with Telegram history
