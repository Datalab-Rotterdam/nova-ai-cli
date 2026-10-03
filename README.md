<div align="center">

<img src="./assets/logo.png" width="96" height="96" alt="Nova logo" />

# @datalabrotterdam/nova-ai-cli

**Agentic coding with DataLab Rotterdam's Nova AI: in your terminal, in scripts, and in your editor over the Agent Client Protocol**

[![npm version](https://img.shields.io/npm/v/@datalabrotterdam/nova-ai-cli?style=flat-square&color=f96743)](https://www.npmjs.com/package/@datalabrotterdam/nova-ai-cli)
[![npm downloads](https://img.shields.io/npm/dm/@datalabrotterdam/nova-ai-cli?style=flat-square)](https://www.npmjs.com/package/@datalabrotterdam/nova-ai-cli)
[![license](https://img.shields.io/npm/l/@datalabrotterdam/nova-ai-cli?style=flat-square)](./LICENSE)
[![ACP](https://img.shields.io/badge/ACP-agent-blue?style=flat-square)](https://agentclientprotocol.com)
[![issues](https://img.shields.io/github/issues/Datalab-Rotterdam/nova-ai-cli?style=flat-square)](https://github.com/Datalab-Rotterdam/nova-ai-cli/issues)

[npm](https://www.npmjs.com/package/@datalabrotterdam/nova-ai-cli) · [Issues](https://github.com/Datalab-Rotterdam/nova-ai-cli/issues) · [ACP reference](./docs/ACP.md) · [Settings and memory](./docs/NOVA_HOME.md)

</div>

`nova-ai` is a coding agent in the spirit of `claude` and `codex`, backed by
[Nova AI](https://platform.nova.datalabrotterdam.nl). It reads and edits your
code, runs commands with your permission, asks when a decision is yours, and
keeps a task list for longer work. One agent, three front ends:

- **Terminal UI**: `nova-ai`
- **Headless**: `nova-ai -p "…"` for scripts, CI and machines without a GUI
- **ACP agent**: `nova-ai --acp` for Zed, JetBrains, VS Code and any other
  [Agent Client Protocol](https://agentclientprotocol.com) client

The terminal UI and headless mode talk to the agent over the same protocol an
editor uses, so all three behave the same: same tools, permissions, sessions,
memory, MCP servers and settings.

## Install

Requires Node.js 22.19 or newer and a Nova AI API key
([get one](https://platform.nova.datalabrotterdam.nl/dashboard/api-keys)).

```sh
npm install -g @datalabrotterdam/nova-ai-cli
nova-ai login          # opens a local page to enter the key; --no-browser asks in the terminal
nova-ai                # start the terminal UI in your project
```

Or without installing: `npx @datalabrotterdam/nova-ai-cli login`, then
`npx @datalabrotterdam/nova-ai-cli`.

```
nova-ai [options]                 Interactive terminal UI
nova-ai -p [options] [prompt]     Run one request headless (see nova-ai -p --help)
nova-ai --acp                     Agent Client Protocol over stdio (for editors)
nova-ai login [--no-browser]      Connect your Nova AI account
nova-ai logout                    Remove the stored API key

Interactive options:
      --resume <session-id>       Continue a saved session
  -c, --continue                  Continue the most recent session in this folder
      --model <id>                Use this model
```

## Terminal UI

The UI renders inline below your shell prompt. Finished messages go to the
terminal's own scrollback (scroll, search and copy as usual); only the
streaming answer, running tools, the prompt and the status rows are redrawn.

- **Modes** (Shift+Tab): `agent` does the work; `plan` reads the code, asks
  questions and builds a task list but changes nothing; `ask` only answers.
- **Permissions**: before an edit or command you choose once, for this
  session, always (saved as an exact rule) or deny. Ctrl+K switches between
  asking, accepting edits, and bypass (never remembered).
- **Questions and tasks**: the agent can ask 1–4 multiple-choice questions
  (with descriptions, a recommended option and your own answer) and shows a
  live checklist for multi-step work.
- **Prompt**: history, `@file` mentions, `/command` completion, large pastes
  as compact markers, Alt+V to paste an image (for models that accept
  images). Messages typed while Nova works are queued; ↑ edits them.
  `/steer <text>` reaches the running turn at the next tool boundary.

| Key | Action |
|---|---|
| Enter / Shift+Enter | Send / new line (Shift+Enter where the terminal supports the kitty keyboard protocol: VS Code, kitty, WezTerm, Ghostty, foot, Alacritty, recent iTerm2; Alt+Enter, Ctrl+J or a trailing `\` work everywhere) |
| Esc | Cancel the running turn |
| Ctrl+C twice | Exit; prints `nova-ai --resume <id>` |
| Shift+Tab | Cycle agent / ask / plan |
| Ctrl+R / Ctrl+P / Ctrl+K | Sessions / models / permission mode |
| Ctrl+O / Ctrl+T / Ctrl+B | Verbose tool output / tool inspector / background jobs |
| Alt+V | Paste a clipboard image |

Slash commands: `/help`, `/model`, `/mode`, `/permission`, `/session`,
`/resume`, `/clear`, `/compact`, `/rewind [n]`, `/queue`, `/steer`, `/usage`,
`/tools`, `/mcp`, `/skills`, `/shell` and `/agent` (background jobs), `/trust`
and `/exit`. Details:
[`src/tui/README.md`](./src/tui/README.md).

## Headless

```sh
nova-ai -p "review the changed files"
git diff | nova-ai -p --output-format json "summarize this diff"
nova-ai -p --json --permission-mode accept-edits "fix the failing test"
nova-ai -p -c "and now add a changelog entry"
```

| Option | |
|---|---|
| `--output-format text\|json\|stream-json` | `text` prints the answer; `json` one object at the end (text, tools, permissions); `stream-json` (or `--json`) JSON Lines while it runs: `session.started`, `message.delta`, `tool.started`/`tool.updated`/`tool.finished`, `permission`, `queue.changed`, `background.update`, `result`, `error` |
| `--permission-mode` | `read-only` (default): anything that needs approval is refused, since nobody can approve it. `accept-edits`: file edits are accepted, commands still refused. `bypass-all`: everything is accepted. Deny rules always win. |
| `--resume <id>`, `-c` | Continue a session |
| `--model`, `--cwd` | Model and workspace |
| `--trust-workspace` | Trust the workspace (remembered): start the MCP servers and apply the allow rules it declares |
| `--no-mcp` | Ignore workspace MCP configuration |

Exit codes: `0` success, `1` configuration or runtime error, `2` cancelled,
`3` tool-turn safety limit, `130` interrupted.

## Editors (ACP)

Configure `nova-ai --acp` as a custom agent. For Zed:

```json
{
  "agent_servers": {
    "Nova AI": { "command": "npx", "args": ["-y", "@datalabrotterdam/nova-ai-cli", "--acp"] }
  }
}
```

The agent supports session load/list/resume/fork/close/delete, modes, a
permission-mode and model selector, permission requests with once / session /
always options, client file system and terminals, form questions, plans, usage
and title updates, MCP servers (stdio, HTTP, SSE), image prompts, and three
login methods (browser, `NOVA_API_KEY`, or `nova-ai login` in a terminal).
Nova-specific features (prompt queue, rewind, compaction, context usage,
background jobs) are `_nova/…` extension methods. Everything is documented in
[docs/ACP.md](./docs/ACP.md).

## Security model

- **The agent enforces permissions**, not the client. Every front end and
  every editor gets the same policy; a client can only answer the questions
  it is asked. Anything other than an explicit "allow" counts as "deny".
- **Deny rules win**, also in bypass mode and for read-only tools.
- **A repository can't approve itself.** Allow rules in a workspace's
  `.nova-ai/settings*.json`, and MCP servers it declares (`.mcp.json`), only
  take effect after you trust that workspace (asked once at startup, `/trust`,
  or `--trust-workspace`). The trust decision is stored in `~/.nova-ai`, never
  in the repository. A repository can't set the permission mode either.
- **"Always allow" saves an exact rule** for that command or path in your
  private `~/.nova-ai/projects/<key>/settings.json`, outside the repository.
  Compound commands (`a && b`, pipes) are checked part by part; substitutions
  and nested shells need an exact rule.
- **File access stays in the workspace** (symlinks resolved); commands run in
  their own process group with a timeout, and the whole tree is stopped on
  cancel.
- **Credentials** are stored in `~/.nova-ai/credentials.json` with mode 0600.
  The browser login page only accepts a one-time token from the same origin.

## Settings, memory and sessions

Everything lives in `~/.nova-ai` (or `$NOVA_AI_HOME`), shared with the Nova
VS Code extension: settings, per-project trust, sessions and memory.

- **Rules**: `{"permissions": {"allow": ["run_command(npm test)", "edit_file(src/*)"], "deny": ["read_file(.env)"]}}`
  in `~/.nova-ai/settings.json`, the private project file, or the workspace's
  `.nova-ai/settings.json` (team, committed) and `.nova-ai/settings.local.json`
  (personal). Claude-style aliases such as `Bash(npm run *)` and `Edit(src/**)`
  work too.
- **Instructions**: `NOVA.md` and `AGENTS.md` in the workspace.
- **Memory**: a `MEMORY.md` index plus notes, globally and per project,
  through the `memory_read` and `memory_write` tools (writes need approval).
- **Skills**: `SKILL.md` files under `.agents/skills`, `.claude/skills` or
  `.codex/skills`, in the workspace or your home folder.
- **MCP servers**: `.mcp.json` or `mcpServers` in `.nova-ai/settings.json`.

The complete layout and rule syntax: [docs/NOVA_HOME.md](./docs/NOVA_HOME.md).

## Models

The model list shows the chat models of your account. On login Nova picks the
first one with native tool calling; `/model` or Ctrl+P changes it (and
remembers the choice), `--model` or `NOVA_MODEL` sets it for one run. Nova uses the gateway's function calling and falls back
to a text protocol for models that don't support it. When the context window
fills up, older messages are summarized automatically (`/compact` does it by
hand).

| Environment | |
|---|---|
| `NOVA_API_KEY`, `NOVA_MODEL` | Use this key / model instead of the stored ones |
| `NOVA_BASE_URL` | Another Nova (OpenAI-compatible) gateway |
| `NOVA_AI_HOME` | Settings folder (default `~/.nova-ai`) |
| `NOVA_TOOL_PROTOCOL` | Force `native` or `text` tool calling |
| `NOVA_NES_MODEL` | Separate model for next-edit suggestions (ACP) |
| `NOVA_KITTY_KEYBOARD` | `1`/`0`: force the kitty keyboard protocol on or off |

## Development

```sh
npm ci
npm test          # type check, unit tests (node:test) and the real-terminal (PTY) scenario
npm run build     # the login page and the CLI bundle in dist/
npm run dev       # run from source with tsx
```

Tests never touch your `~/.nova-ai` or the real Nova API: they run with a
throwaway home folder and point the client at a local port. The ACP
conformance test starts the real `--acp` process against a fake gateway. CI
runs the suite on Linux, macOS and Windows with Node 22 and 24 (the PTY
scenario on Linux and macOS). Releases are cut by `semantic-release` from
`main` and `alpha`.

Planned: OIDC login against the Nova platform instead of a pasted API key,
and Remote Control (driving a running session from the Nova web UI or mobile
app). The standalone browser UI (`--web`) is experimental.

## License

[Apache-2.0](./LICENSE) © DataLab Rotterdam
