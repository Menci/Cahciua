# Driver Development Guide

## Boundaries

Driver is deliberately explicit rather than plugin-driven. New behavior must fit one existing owner before a new abstraction is introduced.

```text
index.ts                   per-chat scope composition
scheduler.ts               reply eligibility and debounce timers
wakeup.ts                  probe -> primary -> forced-send fallback
primary-tools.ts           ordered primary tool construction
runner.ts                  model-call retry and tool execution operations
turn-loop.ts               persistence/follow-up/cooperative-interrupt loop
compaction-controller.ts   independent compaction effect
compaction.ts              summary LLM call
context.ts                 pure context composition and history optimization
tools/                     one module per tool or execution concern
```

Probe is not a generic tool-loop feature. Compaction is not a turn feature. Keep both as explicit phases/controllers.

## Adding A Tool

1. Implement the tool in `src/driver/tools/<name>.ts` with `createTool()`.
2. Export it from `src/driver/tools/index.ts`.
3. Add it to `createPrimaryTools()` in the required model-visible order.
4. Update the Velin system prompt.
5. Test schema, validation, result payload, and follow-up behavior.

Tool results return `requiresFollowUp`. `send_message` maps its `still_working` argument to that flag. A terminal tool must return `false`; tools whose result requires another model step return `true`.

Do not introduce a silence tool. Activated primary wake-ups must send at least one message.

## Adding Wake-Up Behavior

Probe and primary logic lives in `executeWakeup()`. Changes must preserve:

- invalid probe output fails closed;
- probe persistence precedes primary activation;
- only interrupted-loop continuation bypasses probe;
- completed primary steps persist before interruption checks;
- fallback searches the current interruption chain for an earlier send;
- typing begins only after activation and stops in `finally`.

Add characterization tests in `driver-characterization.test.ts` before changing any of these rules.

## Runner Changes

`callModelStep()` may retry ignored forced tool choices. Rejected attempts contribute token usage but must never execute tools. `executeToolStep()` handles only the chosen model entries.

`runTurnLoop()` owns ordering:

```text
model -> tools -> persist -> terminal/follow-up decision -> interrupt -> append
```

Do not add abort checks between model output, side effects, and persistence. That creates externally visible actions without a durable TR and causes duplicate actions on retry.

## Scheduler Changes

The scheduler is the only owner of debounce timers. It receives signals from the chat scope and calls a wake-up executor with an RC snapshot.

Preserve trigger-sender semantics and hard-cap behavior. Use fake timers for tests. Scheduler cleanup cancels pending timers but does not preempt an already-running LLM/tool operation.

## Compaction Changes

Compaction observes RC independently from the reply scheduler. Trigger estimates exclude the existing summary. A successful compaction persists metadata before updating the signal/cursor.

Do not store summaries as TRs or delete historical rows.

## Testing Checklist

- Probe: valid send/no-action, missing/malformed decide, persistence order.
- Primary: still_working, terminal tools, interrupted continuation, fallback.
- Runner: retry limits, usage aggregation, selected-output execution.
- Scheduler: sender-aware delay, typing extension, hard cap, cleanup.
- Compaction: threshold boundaries, cursor window, persistence/update order.
- Context: RC/TR ordering, reasoning compatibility, image and tool-result trimming.
