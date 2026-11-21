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

The Driver uses a mandatory probe/primary gate. A small outside-judge call first decides `send_message`, `any`, or `no_action`; malformed decisions fail closed. `send_message` wakes primary and requires at least one message before the turn finishes; `any` wakes primary with typing and forced tool use for silent or optional-speech actions without requiring a message.

Context compaction runs independently from reply scheduling. It summarizes old raw RC/TR content at a high water mark while retaining a configurable working window. Summaries are append-only and do not enter turn-response storage.

Provider calls are non-streaming and support OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses. Internal conversation history uses a provider-independent IR and converts only at the request boundary.

See [docs/dcp-design.md](docs/dcp-design.md) and [AGENTS.md](AGENTS.md).

## Telegram Runtime

Both bot and optional userbot use `teleproto`, a pure-TypeScript MTProto client with no native dependency. The userbot is the exclusive ingress source when enabled because Telegram bot accounts cannot observe complete group history or all updates. The bot always owns outbound sends.

Ingress is ordered per chat. Enabled image, animation, and custom-emoji descriptions are blocking transforms: unresolved head events prevent later events from committing. Successful bot sends immediately inject a synthetic self-event so the probe sees the bot's action before userbot echo arrives.

## Spam Moderation

Enable `tools.banSpammer: true` in the intended chat override; its default is false. Tool exposure and backend authorization follow this setting. Put the group policy in that chat's `systemFiles` alongside identity files so both probe and primary receive it through the existing injection mechanism.

Store the group policy in a deployment-local Markdown file. Deployment-local group policies can identify eligible accounts through sufficient conversational history showing exclusively one-off solicitation. Genuine questions, feedback, and ordinary exchanges establish normal participation. For normal members discussing topics outside the bot's permitted scope, the bot remains silent on that topic and leaves member conduct to human administrators. Archived names and messages serve as internal reference examples interpreted in context. Backend protections cover owners, administrators, the bot itself, and users with at least 10 archived messages. Accounts outside the group, including inline bots summoned by members, remain eligible because the archive supplies their identity. The summoner is a separate target and is banned through its own mention message. Deleted messages retain their contribution to the observed count; eligibility is independent of join age.

The bot needs administrator permissions to restrict members and delete messages. Its action scope is permanent ban plus deletion of known messages permitted within Telegram's 48-hour bot window, attempted independently so an account that already left still has its messages removed. Existing tool call/result history provides the audit record; message lookup and counting use the existing event archive.

Moderation stays silent when cleanup succeeds and on expected non-actions such as an account that already left or messages that were already deleted. Primary speaks only when an unexpected operational problem blocks cleanup (such as missing bot permissions, a protected target, failed message deletions, messages past the 48-hour window, or a rejected flood), using an anonymous `[spam 账号](tg://user?id=...)` link when available and never repeating names, usernames, spam content, or audit reasoning.

## Setup

Requirements: Node.js >=22, pnpm, `libpng-dev`, and `librlottie-dev`.

```bash
pnpm install
cp config.example.yaml config.yaml
```

Fill `config.yaml`. To enable full-visibility userbot ingress, set `telegram.userbotEnabled: true`, then run `pnpm login` once to save the userbot session to `data/session`. Existing gramjs/teleproto session strings can be reused.

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

Configuration is YAML-first. `CONFIG_PATH` may select a different file; `CONTACTS_PATH` may select a contact-name mapping. For an Anthropic Messages model, set `anthropicBetas` to the exact beta identifiers required by the selected features:

```yaml
models:
  claude:
    apiBaseUrl: "https://api.anthropic.com/v1"
    apiKey: "..."
    model: "..."
    apiFormat: "anthropic-messages"
    anthropicBetas: ["feature-one-YYYY-MM-DD", "feature-two-YYYY-MM-DD"]
```

Per-model reasoning and forced-tool behaviour are configured alongside the endpoint:

```yaml
models:
  kimi:
    # ...
    reasoningEffort: "max"
    forceToolChoiceSupport: anyToolOnly   # none | reasoningDisabledOnly | anyToolOnly | full
```

`reasoningEffort` is one level name that each protocol renders its own way (Anthropic adaptive thinking plus `output_config.effort`, Responses `reasoning.effort`, Chat Completions `reasoning_effort`). Non-effort reasoning settings such as a summary preference stay in `extraBody` and are merged rather than replaced. `forceToolChoiceSupport` controls how a forced call is requested: `full` names the tool, `anyToolOnly` offers only that tool and asks for "any", `reasoningDisabledOnly` keeps reasoning except for the last-resort forced message, and `none` never forces (and skips that last-resort call).

Replace the example identifiers with names from [Anthropic's beta header documentation](https://platform.claude.com/docs/en/api/beta-headers). Cahciua sends them together in one `anthropic-beta` header for requests using that model, including probe, primary, compaction, and media-description calls. A beta may require matching request-body fields or a compatible response codec; the header alone enables only the provider's beta gate. Invalid or unavailable identifiers surface as provider errors.

## Development

The composition root uses statically imported, factory-only tsyringe registrars. Core services remain closure factories and do not receive the container. Startup explicitly owns replay, activation, and shutdown order.

Do not commit or push local databases, sessions, request dumps, or configuration secrets.
