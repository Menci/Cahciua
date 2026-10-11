<p align="center">
  <img src="assets/icon.svg" width="200" height="200" alt="Cahciua">
</p>

<h1 align="center">Cahciua</h1>

<p align="center">A Telegram group-chat bot built around the Deterministic Context Pipeline.</p>

## Architecture

Cahciua reconstructs model context from durable inputs rather than maintaining a mutable chat transcript:

1. Telegram updates are adapted into canonical IM events.
2. A pure reducer projects events into Intermediate Context.
3. Rendering serializes Intermediate Context into provider-independent XML segments.
4. Driver merges those segments with its own stored turn responses and orchestrates LLM/tool calls.

The Driver uses a mandatory probe/primary gate. A small outside-judge call first decides `send_message` or `no_action`; malformed decisions fail closed. Activated primary turns may use tools across multiple steps but must eventually send at least one message.

Context compaction runs independently from reply scheduling. It summarizes old raw RC/TR content at a high water mark while retaining a configurable working window. Summaries are append-only and do not enter turn-response storage.

Provider calls are non-streaming and support OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses. Internal conversation history uses a provider-independent IR and converts only at the request boundary.

See [docs/dcp-design.md](docs/dcp-design.md) and [AGENTS.md](AGENTS.md).

## Telegram Runtime

Both bot and optional userbot use TDLib through `tdl`. The userbot is the exclusive ingress source when enabled because Telegram bot accounts cannot observe complete group history or all updates. The bot always owns outbound sends.

Ingress is ordered per chat. Enabled image, animation, and custom-emoji descriptions are blocking transforms: unresolved head events prevent later events from committing. Successful bot sends immediately inject a synthetic self-event so the probe sees the bot's action before userbot echo arrives.

## Spam Moderation

Enable `tools.banSpammer: true` in the intended chat override; its default is false. Tool exposure and backend authorization follow this setting. Put the group policy in that chat's `systemFiles` alongside identity files so both probe and primary receive it through the existing injection mechanism.

Store the group policy in a deployment-local Markdown file. Deployment-local group policies can identify eligible accounts through sufficient conversational history showing exclusively one-off solicitation. Genuine questions, feedback, and ordinary exchanges establish normal participation. For normal members discussing topics outside the bot's permitted scope, the bot remains silent on that topic and leaves member conduct to human administrators. Archived names and messages serve as internal reference examples interpreted in context. Backend protections cover owners, administrators, the bot itself, and users with at least 10 archived messages. Deleted messages retain their contribution to the observed count; eligibility is independent of join age.

The bot needs administrator permissions to restrict members and delete messages. Its action scope is permanent ban plus deletion of known messages permitted within Telegram's 48-hour bot window. Each call checks current Telegram state and returns its actual outcomes. Existing tool call/result history provides the audit record; message lookup and counting use the existing event archive.

After a confirmed ban, the tool result supplies an exact announcement with a `tg://user?id=...` link labeled "spam 账号". Primary calls `send_message` with exactly one argument, `text`, containing that announcement. Names, usernames, profile text, spam content, media, and audit reasoning stay in the private assessment. Partial cleanup receives its own factual announcement. Link accessibility depends on Telegram clients and account privacy; the numeric UID is also retained in the audit record.

## Setup

Requirements: Node.js >=22, pnpm, `libpng-dev`, and `librlottie-dev`.

```bash
pnpm install
cp config.example.yaml config.yaml
```

Fill `config.yaml`. To enable full-visibility userbot ingress, set `telegram.userbotEnabled: true`, then run:

```bash
pnpm login
```

Then start the bot:

```bash
pnpm start
```

Useful checks:

```bash
pnpm typecheck
pnpm lint
pnpm test:run
pnpm build
```

Configuration is YAML-first. `CONFIG_PATH` may select a different file; `CONTACTS_PATH` may select a contact-name mapping.

Historical retrieval is opt-in through the global `history.enabled: true` setting in `config.yaml`; restart the bot after changing it. The default is false. The switch controls the independent index worker and is the shared capability for its future query tools/APIs. The existing `read_old_messages` tool remains available independently of this setting. When disabled, the bot creates no history database or worker. Core message archives and normal context compaction continue unchanged; history catches up through read-only ID increments and targeted pending-media recovery when re-enabled. All synchronization fingerprints, indexes and progress belong to history.db; no source schema migration is added. Query SDK/API implementation is still pending; see [history-input.md](docs/history-input.md). Reliable rendering tasks and asynchronous media completion delivery are implemented; see the [sync architecture](docs/history-sync-design.md). Core producers never wait for History receipt or construction.

## Development

The composition root uses statically imported, factory-only tsyringe registrars. Core services remain closure factories and do not receive the container. Startup explicitly owns replay, activation, and shutdown order.

Do not commit or push generated TDLib types, local databases, sessions, request dumps, or configuration secrets.
