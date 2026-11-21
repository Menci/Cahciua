# Driver Development Guide

## Boundaries

Driver is deliberately explicit rather than plugin-driven. New behavior must fit one existing owner before a new abstraction is introduced.

```text
index.ts                   per-chat scope composition
scheduler.ts               reply eligibility and debounce timers
wakeup.ts                  probe -> primary -> conditional forced-send fallback
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
4. Put capability-specific group policy in chat `systemFiles`; do not advertise a disabled tool in shared prompts.
5. Test schema, validation, result payload, and follow-up behavior.

Tool results return `requiresFollowUp`. `send_message` maps its `still_working` argument to that flag. `end_turn` returns `false` so primary can close a tool loop cleanly; action and inspection tools return `true` so the model observes their result in a subsequent step.

`ban_spammer` is opt-in through `tools.banSpammer` (default false), enforced at tool exposure and backend authorization. Group decision policy lives in chat `systemFiles` and reaches both probe and primary. The callback is bound to the current chat; its inputs are an evidence message ID and a private reason. The Telegram service owns archive author lookup, permission, protection, and count checks, and runs ban and message deletion independently.

Deployment-local group policies can identify eligible accounts through sufficient conversational history showing exclusively one-off solicitation. Genuine questions, feedback, and ordinary exchanges establish normal participation. For normal members discussing topics outside the bot's permitted scope, the bot remains silent on that topic and leaves member conduct to human administrators. Archived names and messages serve as internal reference examples interpreted in context. When eligible cleanup is the sole reason to act, the group policy directs probe to choose `decide(should_act="any")` so primary can execute `ban_spammer` and finish silently with `end_turn`. Moderation omits chat announcements when cleanup succeeds or when the target or its messages were already absent; only operational problems blocking cleanup instruct primary to send a brief error notice (referencing `[spam 账号](tg://user?id=...)` when available and never echoing names, usernames, spam content, or reasoning).

## Adding Wake-Up Behavior

Probe and primary logic lives in `executeWakeup()`. Changes must preserve:

- invalid probe output fails closed;
- probe persistence precedes primary activation;
- `decide` supports `send_message`, `any`, and `no_action`;
- both `send_message` and `any` activate typing (when configured) and run primary with `forceToolChoice: "any"`;
- only `send_message` requires a message and runs the forced `send_message` fallback when the loop exits cleanly without a send;
- only interrupted-loop continuation bypasses probe, recovering its `send_message` vs `any` mode from the latest activated probe row;
- completed primary steps persist before interruption checks;
- typing begins only after activation and stops in `finally`.

Add characterization tests in `driver-characterization.test.ts` before changing any of these rules.

## Runner Changes

`callModelStep()` retries ignored forced tool choices only when `callLlm` actually applied a constraint (`forceApplied !== false`). Rejected attempts contribute token usage but must never execute tools. `executeToolStep()` handles only the chosen model entries.

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

- Probe: valid `send_message`/`any`/`no_action`, missing/malformed `decide`, persistence order.
- Primary: `still_working`, terminal tools, silent `any` completion, interrupted continuation preserving `any` vs `send_message`, forced-send fallback, confidential moderation error handling.
- Moderation: per-chat opt-in, omitted schemas and shared prompt introductions, group policy injection into both probe/primary, sender/chat binding, 9/10-message boundary, protected members, permissions, deletion age, independent ban/deletion outcomes, silent settlement on absent targets/messages, and confidential error reporting.
- Runner: retry limits, `forceApplied=false` bypass, usage aggregation, selected-output execution.
- Scheduler: sender-aware delay, typing extension, hard cap, cleanup.
- Compaction: threshold boundaries, cursor window, persistence/update order.
- Context: RC/TR ordering, reasoning compatibility, image and tool-result trimming.
