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

## Development

The composition root uses statically imported, factory-only tsyringe registrars. Core services remain closure factories and do not receive the container. Startup explicitly owns replay, activation, and shutdown order.

Do not commit or push generated TDLib types, local databases, sessions, request dumps, or configuration secrets.
