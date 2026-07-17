<div align="center">

<img src="./assets/logo.png" width="96" height="96" alt="Nova logo" />

# @datalabrotterdam/nova-ai-cli

**CLI for DataLab Rotterdam's Nova AI — also speaks Agent Client Protocol**

[![npm version](https://img.shields.io/npm/v/@datalabrotterdam/nova-ai-cli?style=flat-square&color=f96743)](https://www.npmjs.com/package/@datalabrotterdam/nova-ai-cli)
[![npm downloads](https://img.shields.io/npm/dm/@datalabrotterdam/nova-ai-cli?style=flat-square)](https://www.npmjs.com/package/@datalabrotterdam/nova-ai-cli)
[![license](https://img.shields.io/npm/l/@datalabrotterdam/nova-ai-cli?style=flat-square)](./LICENSE)
[![ACP](https://img.shields.io/badge/ACP-agent-blue?style=flat-square)](https://agentclientprotocol.com)
[![issues](https://img.shields.io/github/issues/Datalab-Rotterdam/nova-ai-cli?style=flat-square)](https://github.com/Datalab-Rotterdam/nova-ai-cli/issues)

Talk to DataLab Rotterdam's Nova AI from your terminal, or point your editor/IDE at it via [Agent Client Protocol](https://agentclientprotocol.com) — both modes share the same auth and run on [`@datalabrotterdam/nova-sdk`](https://www.npmjs.com/package/@datalabrotterdam/nova-sdk).

[npm](https://www.npmjs.com/package/@datalabrotterdam/nova-ai-cli) · [Issues](https://github.com/Datalab-Rotterdam/nova-ai-cli/issues) · [ACP docs](https://agentclientprotocol.com)

</div>

> **Work in progress.** ACP and the interactive terminal UI are implemented and
> share the same agent, tools, permissions, sessions, background jobs, and MCP
> integrations. The standalone browser UI (`--web`) remains experimental.

---

## Installation

No install needed — run directly with `npx`:

```sh
npx @datalabrotterdam/nova-ai-cli --setup   # store your Nova API key
npx @datalabrotterdam/nova-ai-cli           # interactive terminal UI
npx @datalabrotterdam/nova-ai-cli --acp     # speak ACP over stdio (editors/IDEs) — fully working
npx @datalabrotterdam/nova-ai-cli --web     # experimental standalone browser UI
```

Or install globally / as a project dependency:

```sh
npm install -g @datalabrotterdam/nova-ai-cli
```

**Requires:** Node.js >= 22.19, a [Nova AI](https://api.nova.datalabrotterdam.nl) API key.

### Terminal logo

The TUI uses a plain Unicode star for the assistant marker, so it can be colored by the terminal theme without installing or configuring custom fonts.

---

## Overview

`nova-ai-cli` is a terminal client for Nova AI, in the same spirit as
`claude`/`codex`. With no flags it runs the interactive terminal UI. Pass
`--acp` to use the same agent over Agent Client Protocol, where it reads
JSON-RPC requests from stdin and writes responses/notifications to stdout for
an ACP-aware editor or IDE. Both paths share credentials, tools, permissions,
MCP integrations, background jobs, and persisted sessions.

```sh
# 1. one-time setup — opens a browser page to verify the key against Nova AI and store it locally
npx @datalabrotterdam/nova-ai-cli --setup

# 2. point your ACP client at this binary
npx @datalabrotterdam/nova-ai-cli --acp
```

Most editors invoke `--acp` for you once configured as an agent — `--setup` is the one command you run by hand first.

**Status:** `--setup`, `--acp`, and interactive terminal chat are implemented.
The standalone `--web` surface remains experimental.

### Interactive terminal UI

The TUI uses synchronized differential rendering in a full-terminal viewport.
It fills the current rows and columns on startup, fully reflows on resize, and
keeps the multiline editor and its status row pinned below the scrollable
transcript. Session/model/tool selection screens temporarily own the full
terminal viewport and use stable full-width rows, so the editor cannot show
through and scrolling replaces the previous terminal cells cleanly.
It includes width-aware Markdown, history/paste/autocomplete, permission
dialogs, tool inspection, background shell/agent inspection, model/session
pickers, progressive skill loading, and resumable exits. Skills are discovered
from `.agents/skills`, `.claude/skills`, and `.codex/skills` in both the user
profile and workspace; `/skills` shows the active catalog.

| Key                                | Action                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `Shift+Tab`                        | Cycle agent / ask / plan mode                                                        |
| `Escape`                           | Cancel active work                                                                   |
| `Ctrl+C` twice                     | Cancel, then exit and print `nova-ai --resume <session-id>`                          |
| `Ctrl+O`                           | Expand/collapse verbose inline tool and background details; read/search stay compact |
| `Ctrl+T`                           | Inspect full tool call details                                                       |
| `Ctrl+B`                           | Inspect background shells and agents                                                 |
| `Ctrl+R` / `Ctrl+P` / `Ctrl+K`     | Sessions / models / permission mode                                                  |
| `Alt+V`                             | Paste a clipboard image as `[#ImageN]` when the selected model supports image input  |
| Mouse wheel / `Shift+Page Up/Down` | Scroll conversation history                                                          |
| `Ctrl+Home` / `Ctrl+End`           | Jump to oldest / newest conversation content                                         |

Enter submits. While a response is streaming, another submission is added to
the FIFO queue and its position appears in the status row. `/steer <message>`
cancels the active response and puts that message at the front of the queue;
`/queue` inspects it and `/queue clear` removes pending messages. `Shift+Enter`
or `Ctrl+J` inserts a newline. Slash commands and `@file` references
autocomplete in the editor.

If Nova reports that the model's maximum context length was exceeded, the
agent summarizes older conversation history, keeps the recent messages, shows
a compaction notice, and retries the interrupted model request once. Use
`/compact` to run the same compaction manually before the limit is reached.
The footer also shows `ctx:used/window`; `/usage` opens an estimated category
breakdown for system instructions, conversation, agents, thinking, tools,
skills, remaining capacity, and the total.

Fine-grained project permissions are configured in `.nova-ai/settings.json`
with Claude-style rules such as `Bash(npm run *)`, `Edit(src/**)`, and deny
rules such as `Bash(npm publish*)`. Deny rules take precedence; choosing
`always` in the TUI stores an exact command/path rule rather than allowing an
entire tool.

`@path`, `@./path`, Windows-style separators, and quoted mentions such as
`@"docs/file with spaces.md"` attach file contents directly from the workspace.

---

## Auth

This agent advertises **Agent Auth** (per [`AUTHENTICATION.md`](https://github.com/agentclientprotocol/registry/blob/main/AUTHENTICATION.md)): when the client calls `authenticate`, the agent itself spins up a local HTTP server, opens your browser to it, and resolves once you've connected your account.

```json
{
  "id": "nova-api-key",
  "name": "Nova API Key"
}
```

Today the page served at that local URL is a small Svelte form that:

1. Collects your Nova API key.
2. Validates it against `client.models.list()`.
3. Picks a default model (first enabled model) and stores `{ apiKey, defaultModel }` in `~/.nova-ai/credentials.json`.

You can also trigger this manually:

```sh
npx @datalabrotterdam/nova-ai-cli --setup
```

Overrides, no browser flow required:

| Env var          | Purpose                                               |
| ---------------- | ----------------------------------------------------- |
| `NOVA_API_KEY`   | Skip stored credentials, use this key                 |
| `NOVA_MODEL`     | Skip stored default model, use this model id          |
| `NOVA_NES_MODEL` | Use a separate, usually faster model for NES requests |

A future version will swap this for real OAuth once DataLab Rotterdam ships an OAuth provider for Nova AI — same local server (`src/acp/auth-server.ts`), same lifecycle, just a different page/flow. Credential handling stays isolated in `src/acp/credentials.ts` either way.

---

## What it implements

| ACP method       | Behavior                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`     | Returns protocol version + the `nova-api-key` agent auth method                                                                          |
| `session/new`    | Allocates a session id with in-memory history                                                                                            |
| `session/load`   | Restores a previously-persisted session and replays its turns as `*_message_chunk` notifications                                         |
| `session/list`   | Lists stored sessions, optionally filtered by `cwd`                                                                                      |
| `session/set_mode` | Selects the advertised `agent`, `ask`, or `plan` interaction mode; permission modes are intentionally rejected                         |
| `authenticate`   | Runs the local browser auth flow (`src/acp/auth-server.ts`) and resolves once a valid key is stored                                      |
| `session/prompt` | Streams a `chat.completions.stream()` call, forwarding `agent_message_chunk` updates as text arrives; drives the tool-calling loop below |
| `session/cancel` | Aborts the in-flight Nova AI request via `AbortController`                                                                               |
| `nes/*`          | Provides ACP Next Edit Suggestions with versioned editor buffers, rich context, cancellation, and accept/reject lifecycle                  |
| `background/*`   | Custom extension methods for background prompt and terminal jobs; see below                                                              |

Text, resource-link, embedded-text, and image prompt blocks are supported. Image
blocks are converted to OpenAI-compatible multimodal chat content only when the
selected model advertises image, vision, or multimodal input capability.

Sessions are persisted to disk (`src/acp/sessions.ts`) so `session/load` can rehydrate history, and a title is auto-derived from the conversation.

### Next Edit Suggestions

Nova advertises the experimental ACP NES capability for editor clients that
support inline suggestions. It consumes full-sync `document/didOpen`,
`document/didChange`, and `document/didClose` events so suggestions use the
current unsaved buffer rather than stale disk content. When document events are
unavailable it can use current-file context or ACP `fs/read_text_file`.

Suggestion requests include bounded recent-file, related-snippet, edit-history,
open-file, and diagnostic context. UTF-16, UTF-8, and UTF-32 positions are
negotiated with the client. New requests cancel older work for the same file;
document changes and `nes/close` also cancel in-flight model requests. Returned
edits are limited, range-checked against the requested document version, checked
for overlap and no-op replacements, and discarded when the buffer changes while
Nova is working. `NOVA_NES_MODEL` can select a faster model without changing the
chat model.

### Tool calling

While streaming a response, the agent watches for a fenced tool-call marker in the model's output (`src/acp/tools/marker.ts`). When one appears, it stops streaming text and instead:

1. Reports the pending call via `session/update` (`tool_call` with status `pending`).
2. Requests permission from the client for any **mutating** tool (`allow_once` / `reject_once`), via `session/request_permission`.
3. Executes the tool and reports the result/error via a `tool_call_update`.
4. Feeds the tool result back into the conversation and loops (up to 10 rounds per prompt) until the model produces a plain answer.

Built-in and session tools (`src/acp/tools/registry.ts` plus mode-scoped tools):

| Tool                       | Mutating | Behavior                                                                                                                                       |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask_user`                 | No       | Uses ACP form elicitation for described single/multiple-choice questions, recommended options, and a final custom-answer choice                |
| `enter_plan_mode`          | No       | One-way agent-to-plan transition; accepts no arguments, cannot change permissions, and disables later tools in the same turn                  |
| `inspect_environment`      | No       | Reports platform, ACP client capabilities, detected commands, package manager, and package scripts                                             |
| `list_directory`           | No       | Lists workspace files/directories with path bounds and result limits, gated by client `fs.readTextFile` capability                             |
| `search_text`              | No       | Searches workspace text files with literal/regex modes and excludes common generated directories, gated by client `fs.readTextFile` capability |
| `read_file`                | No       | Reads a file's contents, gated by client `fs.readTextFile` capability                                                                          |
| `load_memory`              | No       | Loads one discovered global or workspace memory note on demand                                                                                 |
| `save_memory`              | Yes      | Atomically creates or updates a bounded persistent memory note - requires permission                                                          |
| `run_package_script`       | Yes      | Runs a detected `package.json` script with npm/pnpm/yarn when a package manager and ACP terminal support are available - requires permission   |
| `write_file`               | Yes      | Writes/overwrites a file, gated by client `fs.writeTextFile` capability — requires permission                                                  |
| `run_command`              | Yes      | Runs a shell command in the session's `cwd` — requires permission                                                                              |
| `start_background_command` | Yes      | Starts a long-running ACP terminal job, such as a dev server, and returns its job id - requires permission                                     |
| `start_background_agent`   | Yes      | Starts another Nova agent turn in the background and returns its job id - requires permission                                                  |
| `list_background_jobs`     | No       | Lists background jobs for the current session                                                                                                  |
| `read_background_output`   | No       | Reads stored agent output or current terminal output for a background job                                                                      |
| `kill_background_job`      | Yes      | Stops a running background command or agent job - requires permission                                                                          |
| `release_background_job`   | Yes      | Releases background job resources; terminal jobs are released through ACP - requires permission                                                |

Tools are filtered per-session by the client's advertised `clientCapabilities`, the detected workspace environment, and available host services. Background tools are offered only when the agent has a background job service for the session.

Nova AI advertises `agent`, `ask`, and `plan` through standard ACP session
modes. `enter_plan_mode` is offered only in agent mode; ask and plan mode expose
no tools. Permission policy is client-owned and deliberately absent from this
mode API, so the model cannot select `acceptEdits` or `bypassAll`.

`ask_user` is offered only when the client advertises ACP form elicitation.
The TUI renders it as a bordered, keyboard-driven dialog and always adds an
`Other...` option with text input. See [`src/tui/README.md`](./src/tui/README.md#interactive-questions)
for the request shape.

### Persistent memory

Persistent memory is implemented at the agent layer through normal ACP tool
calls, so every compatible client can display memory recall and save operations
without a Nova-specific protocol extension. The model receives a small catalog
of note names, types, scopes, and descriptions; full note contents enter context
only after `load_memory` is called.

`save_memory` writes either global notes under `~/.nova-ai/memory/global` or
workspace notes under a short hashed workspace directory. Workspace notes
override same-named global notes. Saves require the normal mutating-tool
permission, default to workspace scope, use an atomic replacement, and refresh
the live session catalog immediately. Names and metadata are strictly validated,
individual notes are bounded, and the memory policy tells the model not to store
secrets, credentials, personal data, or raw output. Memory is reported as its own
category in `/usage`.

Supported note types are `user`, `feedback`, `project`, and `reference`.

### MCP servers

The interactive TUI reads the common project-local `.mcp.json` format and the
existing `.nova-ai/settings.json` MCP array, then passes the merged servers
through the same in-process ACP session used by editors. Project entries
override same-named `.nova-ai` entries. Stdio, HTTP, and SSE transports are
supported. Connected tools use the normal tool-call, permission, and rendering
flow; invalid configuration and failed connections are reported without
printing child-process stderr into the terminal UI.

Use `/mcp` in the TUI to inspect configured, connected, and failed servers.
Environment and header values are deliberately hidden. See
[`src/tui/README.md`](./src/tui/README.md#mcp) for the configuration format.

### Background jobs

ACP does not yet standardize durable background agent jobs, so `nova-ai-cli` exposes a small custom extension API. These methods are ordinary JSON-RPC requests with method names outside the core ACP namespace:

| Extension method            | Params                                                                                       | Behavior                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `background/start_prompt`   | `{ "sessionId": "...", "prompt": [{ "type": "text", "text": "..." }], "title": "optional" }` | Starts a Nova agent turn in the background and returns `{ job }` immediately                        |
| `background/start_terminal` | `{ "sessionId": "...", "command": "npm run dev", "title": "optional" }`                      | Creates an ACP terminal, keeps it registered as a background job, and returns `{ job }` immediately |
| `background/list`           | `{ "sessionId": "optional" }`                                                                | Lists tracked background jobs                                                                       |
| `background/output`         | `{ "jobId": "..." }`                                                                         | Returns stored prompt output or current ACP terminal output, plus `outputPath`                      |
| `background/kill`           | `{ "jobId": "..." }`                                                                         | Aborts a prompt job or sends `terminal/kill` for a terminal job                                     |
| `background/release`        | `{ "jobId": "..." }`                                                                         | Releases a terminal job and removes its live process resources; running prompt jobs are aborted     |

The agent also emits custom `background/update` notifications with `{ event, job }`, where `event` is one of `started`, `event`, `completed`, `failed`, `killed`, or `released`. Prompt jobs include streamed internal events in the notification payload; terminal jobs stay attached to the ACP terminal id until killed or released. Each job summary includes an `outputPath` under `~/.nova-ai/background-jobs/`; prompt output is appended as it streams, and terminal output is snapshotted when `background/output` is called or when the terminal exits.

---

## Development

```sh
npm install
npm test      # tsc --noEmit + node --test on tests/
npm run build # builds the setup page and Node CLI into dist/
```

Releases are automated via `semantic-release` on push to `main` (see `.github/workflows/ci.yml`); commit messages drive version bumps.

---

## License

[Apache-2.0](./LICENSE) © DataLab Rotterdam
