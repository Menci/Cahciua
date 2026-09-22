# Telegram Module Architecture

## Module Ownership

```text
bot.ts / userbot.ts
  raw TDLib clients
        |
        v
manager.ts
  active ingress ownership, ordered transform queue, send/download facade
        |
        +--> live-handlers.ts --> event-sink.ts --> Pipeline --> DriverInputBus
        |
        +<-- driver-hooks.ts <-- Driver tools
        |
        +--> post-startup.ts (historical media work)
```

- `bot.ts`: bot authentication, outbound actions, bot-limited ingress fallback.
- `send-tracker.ts`: pairs bot sends with TDLib's terminal send updates.
- `userbot.ts`: full-visibility ingress, history, typing, and preferred downloads.
- `manager.ts`: creates the single active ingress stream and blocks on media transforms.
- `adaptation.ts`: Telegram message/entity structures to canonical events.
- `live-handlers.ts`: canonical/message-store side-effect ordering for live updates.
- `event-sink.ts`: canonical persistence plus configured-chat publication boundary.
- `driver-hooks.ts`: sends, reactions, downloads, and synthetic self-events.
- `post-startup.ts`: animation hash and custom-emoji backfills.
- `moderation.ts`: chat/user protection rules, current-state checks, and ban/deletion execution.
- `moderation-api.ts`: bot-only TDLib moderation calls and message-ID conversion.
- `../db/moderation.ts`: sender lookup and distinct message-ID queries against the existing archive.

Generic media code belongs in `src/media/`, not Telegram.

## Client Ownership

Bot is always present and always sends. Userbot is optional. When userbot exists it exclusively owns messages, edits, deletes, and typing ingress; bot ingress is not merged with it.

The manager's known-chat set starts with persisted chat IDs and expands on new messages. Edits, deletes, and typing for unknown chats are ignored until the chat is known. TDLib delete updates must carry their chat ID.

## Live Ingress Ordering

Regular messages:

```text
adapt
-> persist Telegram message row
-> persist canonical event
-> configured? hydrate cached alt text
-> Pipeline push
-> DriverInputBus
```

Edits and deletes use the same retriable persistence boundary. Service events have no platform message-row write. Repeated commit attempts reuse the same canonical object, so platform persistence, canonical persistence, Pipeline publication, and Driver notification are idempotent.

Unconfigured chats always retain the canonical/platform archive but never hydrate/project/wake.

## Blocking Transforms

Bot and userbot capture ingress timestamps when the raw TDLib update arrives. Userbot re-fetches are serialized per chat; metadata, image, animation, and custom-emoji transforms then run through the manager's ordered queue. Later transforms may finish early but cannot commit past an unresolved head.

Transform failures are retried and keep the queue blocked. Do not replace this with timeout fallback or empty alt text.

## Driver Egress

Driver hooks translate `send_message` attachments into Telegram sends and use the configured workspace read command for file bytes.

Bot sends resolve through the send tracker: TDLib returns a per-dialog yet-unsent id immediately, while the media upload and server confirmation continue asynchronously. The invoke is only considered complete when TDLib emits `updateMessageSendSucceeded` (which carries the final server message id) or `updateMessageSendFailed`. There is no timeout — long uploads and FLOOD_WAIT retries legitimately keep a message pending — and pending sends are aborted only when the bot client stops. Temp files backing `inputFileLocal` are deleted after the terminal update, since removing them earlier breaks the upload.

After the confirmed send, each returned Telegram message becomes a synthetic canonical message with `isSelfSent=true`:

```text
send confirmed
-> adapt synthetic TelegramMessage
-> persist canonical event
-> configured? hydrate + Pipeline push
-> no Driver wake-up
```

For media groups, one synthetic event is created per returned message. The first carries the caption, matching Telegram echo behavior.

## Spam Moderation

Tool exposure and backend authorization require the current chat to enable `tools.banSpammer` (default false). Group policy is injected through chat `systemFiles`. Deployment-local group policies can identify eligible accounts through sufficient conversational history showing exclusively one-off solicitation. Genuine questions, feedback, and ordinary exchanges establish normal participation. For normal members discussing topics outside the bot's permitted scope, the bot remains silent on that topic and leaves member conduct to human administrators. Archived names and messages serve as internal reference examples interpreted in context.

The Driver tool supplies an evidence message ID and a private reason. Its chat comes from the active Driver scope, and its target UID comes from persisted canonical message/edit events. The backend refuses missing evidence, non-user senders, self, protected membership states, missing bot permissions, and targets with 10 or more distinct observed message IDs. Edits do not inflate this count; deletes and context compaction do not reduce it. Service messages do not count. Unobserved history and message types not admitted by adaptation are outside this archive count.

Execution uses the bot client even when userbot owns ingress. Load and verify the evidence through that bot, recheck the archive count, ban permanently, then load each known target message into the bot's own TDLib cache, check its sender/date/deletion properties, and delete it. An already-banned target can be cleaned up using the archived evidence identity after its evidence message has disappeared. Fresh calls require current evidence for an ordinary member. TDLib requires loaded message IDs for server deletion. The action scope is permanent ban plus permitted deletion of known messages younger than 48 hours.

The Driver serializes tool calls per chat. Each invocation queries current state and returns successful, unavailable, undeletable, and failed message IDs. A failed ban propagates to the existing tool error handler; deletion failures are logged and returned alongside successful deletions. The existing tool call/result history owns the audit trail, including the evidence ID, private reason, target UID, and returned outcomes.

Confirmed deletions and messages already unavailable to the bot update the platform archive and emit canonical delete events through the event sink without waking Driver. Repeating publication is safe for Projection. A subsequent userbot delete echo is also harmless. No direct IC mutation is allowed.

The tool result requires model follow-up. After a confirmed ban, the tool result supplies an exact announcement with a `tg://user?id=...` link labeled "spam 账号". Primary calls `send_message` with exactly one argument, `text`, containing that announcement. Names, usernames, profile text, spam content, media, and audit reasoning stay in the private assessment. Partial cleanup receives its own factual announcement.

## Downloads

Logical attachment IDs are `messageId:index`. Driver validates them against persisted attachments. Manager asks userbot for current message/file references first and falls back to bot. TDLib-local file IDs never enter durable event data.

## Startup And Shutdown

Handlers register before client start. Driver is attached to the input bus before start but remains inactive; context updates during start are coalesced per chat. After both clients start, Driver activates, background tasks recover, and current resident RC is seeded.

Shutdown deactivates Driver input before stopping Driver/background tasks and clients. SQLite closes after Telegram stops.

## Extending Telegram

Put raw TDLib translation in bot/userbot/message modules, ingress side effects in live handlers, outbound capability in driver hooks, and historical work in post-startup tasks. Add a new shared persistence port only when more than one Telegram module needs it.
