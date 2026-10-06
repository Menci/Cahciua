# Rendering and model-context interfaces

The reusable record and model-context contracts serve different consumers. They have different shapes and owners, so passing a rendering result directly to model consumers is a type error.

```mermaid
flowchart LR
  IC[Projection: IC] --> R[Rendering: immutable records]
  R --> P[Pipeline: resident records and diff baseline]
  P --> V[Driver: cursor and visibility conversion]
  V --> RC[Driver: model segments]
  RC --> M[Scheduler, probe, primary and compaction]
```

## Rendering's public record

`src/rendering/types.ts` owns a discriminated union of message, system and runtime records:

```typescript
{
  kind: 'message',
  metadata: { chatId, messageId, receivedAtMs, sender, replyTo, /* ... */ },
  presentation: { body, blocked },
  activation: { isMyself, mentionsMe, repliesToMe },
}
```

The metadata is an explicit output contract. It carries identity, timestamp and message-state information without exporting an `ICNode`, its content tree or its cache revision. Sender/reply/forward and attachment metadata are copied into independent read-only snapshots. Attachment metadata contains descriptions and logical attributes, not thumbnail bytes. Runtime metadata carries task identity; system records need only the shared timeline metadata.

`presentation.body` contains the complete existing message XML and runtime image handles. Rendering also prepares the header-only blocked form from the same attributes. These are display forms; Rendering does not read a block list or select a model window. Activation facts depend only on source content and the bot identity used by formatting.

The IC node identity, revision comparison and cache entries are private to `createRenderer()`. Source and display-parameter changes invalidate records; view, summary, model and budget changes do not. Records and body arrays are read-only. Sharp handles are shared runtime resources; request codecs clone them before resize/encoding.

## Driver's model context

`src/driver/context-types.ts` owns the existing model segment contract:

```typescript
{
  receivedAtMs,
  content,
  senderId,
  // Scheduling and activation flags only.
}
```

`selectContextView()` is the explicit conversion. It applies the cursor, selects normal or blocked presentation, suppresses blocked images and mention/reply flags, and copies only model/scheduling fields. It never spreads a record or its metadata. Scheduling, probe, primary, merge and compaction accept this model contract. Live inputs and historical `read_old_messages` both cross this conversion.

The distinct shapes provide the check: rendering records have no model `content` array or top-level `receivedAtMs`, and model segments have no record `kind`, `metadata` or `presentation`. No brand casts, compatibility aliases or generic wrapping adapters are needed. Type assertions in the context-view tests verify that neither collection is assignable to the other or to model-consumer inputs.

## Pipeline's lifetime

Pipeline selects resident IC nodes before construction and owns cursor-based retention. Cursor updates evict renderer cache entries and filter its stored record array, without regenerating content or publishing input. Filtering preserves retained record identity and prevents a later diff from treating all compacted messages as deletions.

Driver holds its own input snapshot. Its metadata signal advances the model view independently; the Pipeline array replacement does not mutate that snapshot. Old records referenced by Driver remain alive until the next input replaces it. Neither this contract nor caching requires an all-history rendering collection. Cold replay still loads the active event window; Projection's existing IC/reply-snapshot lifetime is unchanged.

## Scope

These interfaces prepare reuse by another consumer. They do not implement a history database, indexing queue, archival IDs, timeline extraction or a new storage schema. A consumer that needs additional archive metadata should receive an explicit contract extension at that seam rather than access Projection or renderer cache internals.
