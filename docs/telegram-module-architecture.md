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
- `userbot.ts`: full-visibility ingress, history, typing, and preferred downloads.
- `manager.ts`: creates the single active ingress stream and blocks on media transforms.
- `adaptation.ts`: Telegram message/entity structures to canonical events.
- `live-handlers.ts`: canonical/message-store side-effect ordering for live updates.
- `event-sink.ts`: canonical persistence plus configured-chat publication boundary.
- `driver-hooks.ts`: sends, reactions, downloads, and synthetic self-events.
- `post-startup.ts`: animation hash and custom-emoji backfills.

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

After a successful send, each returned Telegram message becomes a synthetic canonical message with `isSelfSent=true`:

```text
send succeeds
-> adapt synthetic TelegramMessage
-> persist canonical event
-> configured? hydrate + Pipeline push
-> no Driver wake-up
```

For media groups, one synthetic event is created per returned message. The first carries the caption, matching Telegram echo behavior.

## Downloads

Logical attachment IDs are `messageId:index`. Driver validates them against persisted attachments. Manager asks userbot for current message/file references first and falls back to bot. TDLib-local file IDs never enter durable event data.

## Startup And Shutdown

Handlers register before client start. Driver is attached to the input bus before start but remains inactive; context updates during start are coalesced per chat. After both clients start, Driver activates, background tasks recover, and current resident RC is seeded.

Shutdown deactivates Driver input before stopping Driver/background tasks and clients. SQLite closes after Telegram stops.

## Extending Telegram

Put raw TDLib translation in bot/userbot/message modules, ingress side effects in live handlers, outbound capability in driver hooks, and historical work in post-startup tasks. Add a new shared persistence port only when more than one Telegram module needs it.
