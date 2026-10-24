# Nova over the Agent Client Protocol

`nova-ai-agent --acp` (package `@datalabrotterdam/nova-ai-agent`) is an
[Agent Client Protocol](https://agentclientprotocol.com) agent: JSON-RPC 2.0 as
newline-delimited JSON over stdin/stdout. `nova-ai --acp` from the CLI package
runs the same agent. This page is
the reference for clients that embed it (editors, IDEs, custom hosts). The
terminal UI and `nova-ai -p` use exactly this protocol in-process, so
everything below is exercised by Nova's own front ends.

- SDK: `@agentclientprotocol/sdk` 0.29; protocol version as negotiated in
  `initialize`.
- stdout carries protocol messages only. Anything else the process prints
  (including `console.log` from dependencies) goes to stderr.
- The process exits cleanly (prompts cancelled, background jobs and MCP
  servers stopped, sessions flushed) on stdin EOF, `SIGINT` or `SIGTERM`.

## Quick start

```jsonc
// Zed: settings.json
{
  "agent_servers": {
    "Nova AI": { "command": "npx", "args": ["-y", "@datalabrotterdam/nova-ai-agent", "--acp"] }
  }
}
```

Run `nova-ai-agent login` (or `nova-ai login`) once, or let the client run one
of the auth methods below.

## initialize

The agent answers with:

| Field | Value |
|---|---|
| `agentInfo` | `{ name: "nova-ai-cli", title: "Nova AI", version }` (the agent package's version; the name is kept for existing clients) |
| `loadSession` | `true` |
| `promptCapabilities` | `image`, `embeddedContext` |
| `mcpCapabilities` | `http`, `sse` (stdio is always supported) |
| `sessionCapabilities` | `list`, `close`, `delete`, `fork`, `resume` |
| `providers`, `nes` | unstable SDK capabilities, see below |
| `_meta["nova-ai-cli"]` | `{ version, methods, notifications }`: the `_nova/` extensions this agent serves |

### Authentication

| `authMethods[].id` | Type | What happens |
|---|---|---|
| `nova-api-key` | agent | `authenticate` opens a local page in the browser; resolves once a valid key is stored |
| `nova-api-key-env` | `env_var` | Start the agent with `NOVA_API_KEY` (and optionally `NOVA_MODEL`) |
| `nova-login-terminal` | `terminal` | The client runs the agent's command with `login --no-browser` in a terminal (hidden key input) |

Keys are stored in `~/.nova-ai/credentials.json` (mode 0600). A request that
needs Nova without credentials fails with `authRequired`.

## Sessions

| Method | Notes |
|---|---|
| `session/new` | Starts MCP servers (in parallel, 10 s timeout each; failures are reported, not fatal): the client's plus, in a trusted workspace, those it declares in `.mcp.json` and `.nova-ai/settings.json` (the client's win by name; `_meta["nova-ai-cli/workspaceMcp"]: false` leaves the workspace's out). Returns `modes` and `configOptions`. |
| `session/load` | Replays the stored conversation: user and agent text, and tool calls with their final status, diff and (truncated) output. |
| `session/resume` | Like load, without the replay. |
| `session/fork` | Copies a stored session under a new id. |
| `session/list` | 50 per page with an opaque `cursor`; optional `cwd` filter. With a `cwd`, it first imports the VS Code panel's chats of that workspace that are not imported yet (see below). |
| `session/close` / `session/delete` | Close cancels a running turn and stops the session's MCP servers; delete also removes the stored file. Background jobs keep running until killed or the agent exits. |
| `session/prompt` | One turn. Prompts for the same session are queued and run one after another. |
| `session/cancel` | Aborts the model request and running tools, answers pending permission requests as cancelled, marks open tool calls failed ("Cancelled"), then returns `stopReason: "cancelled"`. |
| `session/set_mode` | `agent`, `ask`, `plan` or one of the user's agent files (see Modes). Permission modes are rejected here. |
| `session/set_config_option` | `permission_mode` and `model` (see below). |

Session ids are UUIDs; anything else is rejected with `invalidParams`.
Unknown sessions give `resourceNotFound`. Sessions are stored as JSONL under
`~/.nova-ai/projects/<project-key>/cli-sessions/` (see
[NOVA_HOME.md](./NOVA_HOME.md)).

**Chats of the VS Code panel.** The extension's built-in chat panel keeps its
chats in `projects/<key>/sessions/`. Listing a workspace's sessions
(`session/list` with a `cwd`, and the CLI's `/resume` and `--continue`)
imports the ones not imported before: same id and title, one turn per user
prompt (so checkpoints and rewind work), tool calls with their results, the
extension's tool names mapped to the agent's. Imported ids are recorded in
`cli-sessions/extension-import.json`, so a deleted import does not come back;
the extension's files are not changed.

### Prompts

Text, images (`promptCapabilities.image`) and files
(`embeddedContext`). An embedded `resource` reaches the model as
`<attached_file path="/abs/path" lines="10-20">…</attached_file>`, a
`resource_link` as `[Attached file, not included: /abs/path, lines 10-20]`
(the model reads it with `read_file` when needed). File URIs become paths; a
`#L10-L20` or `#L10` fragment is the selected line range.

### Session settings

Clients can tune a session with `_meta["nova-ai-cli/settings"]` on
`session/new`, `load`, `resume` and `fork`, and change it later with
`_nova/session/set_settings`. Keys left out keep the agent's defaults;
numbers are clamped to the range shown, other types are ignored.

| Key | Range | Default | Effect |
|---|---|---|---|
| `maxToolRounds` | 1–200 | 64 | Tool rounds per turn before the model must answer (`stopReason: "max_turn_requests"`) |
| `autoCompact` | boolean | `true` | Summarize older messages when the context runs full; `false` lets an overflow fail the turn |
| `compactThreshold` | 0.3–0.95 | 0.8 | Share of the context window at which a turn compacts before calling the model |
| `memory` | boolean | `true` | Memory, `NOVA.md` and `AGENTS.md` in the prompt, and the memory tools |
| `commandTimeoutSeconds` | 5–600 | 120 | Time limit for commands that set no `timeout_seconds` |
| `searxngUrl` | http(s) URL, or `null`/`""` | `webSearch.searxngUrl` of `~/.nova-ai/settings.json`, else `null` | A SearXNG server (JSON format enabled) that `web_search` tries before You.com and DuckDuckGo |

### Modes

| Mode | Tools |
|---|---|
| `agent` | All tools, plus `enter_plan_mode` |
| `plan` | Read-only: `read_file`, `list_directory`, `find_files`, `search_text`, `memory_read`, `load_skill`, plus `ask_user` and `update_plan` |
| `ask` | None |
| an agent file's id | What its `tools` and `readOnly` allow (all tools when it lists none); its body is added to the system prompt |

`modes.availableModes` lists the built-in modes, then the user's agent files
(`~/.nova-ai/agents/*.agent.md` and the project's; NOVA_HOME.md, "Agents"),
read when the session starts. Files are read again on every prompt, so an
edited one applies from the next message.

The model can move itself from `agent` to `plan` with `enter_plan_mode`
(reported as `current_mode_update`); it can never move to a less restricted
mode.

### Config options

| `configId` | Values |
|---|---|
| `permission_mode` | `default` (ask for every change), `acceptEdits` (file edits are accepted), `bypassPermissions` (everything is accepted; deny rules still apply). Set per session, never stored by the agent. |
| `model` | The chat models of the account (embedding and speech models are left out); thinking models have the description "Thinking model". Present when the model list can be fetched; `config_option_update` follows when it loads late. |
| `thought_level` (category `thought_level`) | The current model's `reasoning_effort` levels, lowest first (`none` is "Off"; a model that reasons without levels gets Off/On). Only present when the current model has levels. The choice is kept across model switches; a model that lacks it uses its default: `none` when it thinks only on request, else `medium` or its middle level. |

### Session updates

Besides text (`agent_message_chunk`), reasoning (`agent_thought_chunk`),
`tool_call`/`tool_call_update` and `plan`, the agent sends:

- `usage_update` after each turn (token usage from the gateway);
- `session_info_update` with the title derived from the conversation;
- `available_commands_update`: `/compact` (summarize older messages);
- `current_mode_update` and `config_option_update` when they change.

Tool calls carry `kind`, `locations`, `rawInput`, `diff` content for edits
and an embedded `terminal` for commands run through the client's terminal.
`_meta["nova-ai-cli/tool"]` holds the tool name.

## Permissions

The agent decides; clients only answer. Rules come from `~/.nova-ai`,
`~/.nova-ai/projects/<key>/settings.json` and the workspace's `.nova-ai/`
files; workspace allow rules only count once the user trusted the workspace.
Deny rules always win. The full contract is in [NOVA_HOME.md](./NOVA_HOME.md).

When a call needs approval, `session/request_permission` offers:

| `optionId` | `kind` | Effect |
|---|---|---|
| `allow_once` | `allow_once` | This call |
| `allow_session` | `allow_always` | Same tool and subject for the rest of the session (`_meta["nova-ai-cli/scope"] = "session"`) |
| `allow_always` | `allow_always` | Saves the exact rule in `~/.nova-ai/projects/<key>/settings.json` (`_meta["nova-ai-cli/rule"]`) |
| `reject_once` | `reject_once` | Rejects the call |

The tool call includes a readable title (``Run `npm test` ``, `Edit src/x.ts`),
locations and a diff or command preview. Any other answer, an error, or a
disconnect counts as a rejection. Decisions the policy made without asking are
reported on the tool call as `_meta["nova-ai-cli/permission"]`.

## Client capabilities Nova uses

| Capability | Used for |
|---|---|
| `fs.readTextFile` / `fs.writeTextFile` | `read_file`, `list_directory`, `find_files`, `search_text` / `write_file`, `edit_file` (unsaved editor buffers are seen) |
| `terminal` | `run_command`, `run_package_script`, background commands: created with `cwd`, an output limit and a timeout, then killed |
| `elicitation.form` | `ask_user`: 1–4 questions, single or multiple choice, option descriptions, a recommended option and a free-text "Other" answer |

Without a capability the matching tools are not offered.

`fetch_url` (read a web page as text, or JSON and other text as it is) needs
no capability: the agent fetches it itself. It always asks for approval
unless a rule allows the URL, because a URL can carry data out. It only
follows redirects on the same site; a redirect elsewhere is reported and needs
its own call.

`web_search` (also no capability) searches with keyless providers (the
session's `searxngUrl` first, then You.com, then DuckDuckGo; one that fails
falls through to the next), opens the top four result pages and returns the
passages that match the query as numbered sources to cite. The query leaves
the machine like a `fetch_url` URL, so it asks for approval unless a rule
allows it (`web_search` or `web_search(<glob>)` on the query).

MCP tools ask for approval unless the server marks them
`annotations.readOnlyHint: true`.

## Tool calling

Nova uses the gateway's native function calling (`tools` / `tool_calls`). For
models that reject it, it falls back to a text protocol and remembers that per
model in `~/.nova-ai/model-capabilities.json`. `NOVA_TOOL_PROTOCOL=native|text`
forces one. A turn ends after 64 tool rounds (the `maxToolRounds` setting)
with `stopReason: "max_turn_requests"`.

## Nova extensions (`_nova/…`)

Extension methods use the `_` prefix the spec reserves, so they never collide
with standard methods; they are listed in `initialize` under
`agentCapabilities._meta["nova-ai-cli"]` with a `version` (currently 1) that
is bumped on incompatible changes. All take a `sessionId` unless noted.

### Prompt queue

The queue belongs to the agent session, so every client sees the same order.
Entries: `{ id, version, text, kind: "followup" | "steer", createdAt, editing }`.
A `steer` entry is injected into the running turn at the next tool boundary.

| Method | Params | Result |
|---|---|---|
| `_nova/queue/enqueue` | `text`, `prompt` (content blocks), `kind?`, `front?` | `{ entry, entries }` |
| `_nova/queue/list` | | `{ entries }` |
| `_nova/queue/edit_begin` | `id` | `{ updated, entries }`; locks the entry against being taken |
| `_nova/queue/update` | `id`, `text?`, `prompt?`, `editing?`, `kind?`, `front?`, `expectedVersion?` | `{ updated, entries }`; refused on a version mismatch. `kind` switches between follow-up and steer; `front: true` moves the entry first (with `kind: "steer"`: "send now") |
| `_nova/queue/remove` | `id` | `{ removed, entries }` |
| `_nova/queue/clear` | | `{ cleared, entries }` |
| `_nova/queue/take_next` | | `{ entry }` (with its `prompt`), or `{ entry: null }` |

Notification `_nova/queue/changed`: `{ sessionId, entries }`.

### Rewind, compaction and context usage

| Method | Params | Result |
|---|---|---|
| `_nova/session/checkpoints` | | `{ checkpoints: [{ checkpointId, createdAt, userText, messageCount }] }` |
| `_nova/session/rewind` | `turns?` (default 1) | `{ removedCheckpoints, remainingCheckpoints, messageCount }`; clears the queue |
| `_nova/session/compact` | `model?` | `{ compacted, removedMessages, keptMessages }` |
| `_nova/session/context_usage` | `contextWindow?`, `model?`, `mode?` | Estimated tokens per category (system, conversation, agents, thinking, tools, skills, memory) and the total; without `contextWindow` the agent looks up the window of `model` (else the session's or the default model) |
| `_nova/session/set_settings` | `settings` (see Session settings) | `{ settings }`: the settings now in force, with `null` for "the agent's default". Merged over the current ones; applies from the next turn |

Notification `_nova/session/rewound`: `{ sessionId, removedCheckpoints,
remainingCheckpoints, messageCount }`. Rewind and compaction are refused while
a prompt runs. Session files are append-only; a rewind appends a reset record.

### Models

| Method | Params | Result |
|---|---|---|
| `_nova/models/list` | `preferred?` (no session id needed) | `{ models, defaultModel }`: the chat models (fields as in `nova-ai-cli/models` below) and the model to use given `preferred` (else the saved default): kept unless the gateway says it cannot chat or is disabled, `null` when there is none |

### Skills

| Method | Params | Result |
|---|---|---|
| `_nova/skills/list` | `cwd` (no session id needed) | `{ skills: [{ name, description, source, path, enabled, bundledBy? }] }`: every skill discovered for the workspace, switched-off ones included; `bundledBy` names the app that ships a bundled skill (NOVA_HOME.md, "Bundled skills"), whose files the file tools refuse to change |
| `_nova/skills/set_enabled` | `cwd`, `name`, `enabled`, `scope?` (`"project"`, the default, or `"global"`) | `{ skills }` after the change; sessions use it from their next turn. An unknown name is `invalidParams` |

### Hooks

The agent runs the user's hooks (Claude Code's format, `hooks` in the Nova
settings files; a workspace's own only when it is trusted; see NOVA_HOME.md,
"Hooks") for every client: `SessionStart` and `UserPromptSubmit` before a
prompt, `PreToolUse` before the permission check (exit 2 or a `deny` blocks
the call; an `allow` answers in place of `session/request_permission`, deny
rules still win), `PostToolUse` after a tool ran (feedback for the model),
and `Stop` when the turn would end (a block continues the turn, at most three
times), also for background agents' tool calls. A blocked prompt ends the
turn with an `agent_message_chunk` saying why; hook warnings and Stop
decisions arrive as `agent_thought_chunk`.

### MCP sign-in

HTTP and SSE servers that answer 401 are signed in with OAuth (discovery,
dynamic client registration, PKCE; tokens refreshed automatically and kept in
`~/.nova-ai/mcp-auth`). Without tokens the server is reported in
`nova-ai-cli/mcp` failures with `needsAuth: true`. A server's `_meta["nova-ai-cli/oauth"]`
(`clientId`, `clientSecret`, `scope`, `callbackPort`; from `oauth` in
`.mcp.json`) sets a client registered by hand.

| Method | Params | Result |
|---|---|---|
| `_nova/mcp/login` | `serverName` | Signs in, then reconnects the server; returns the session's `nova-ai-cli/mcp` and `nova-ai-cli/skills` status. The page to open arrives first as notification `_nova/mcp/auth_url` `{ sessionId, serverName, url }`; the redirect goes to a one-off listener on `127.0.0.1`, and the request fails after 5 minutes or when cancelled |
| `_nova/mcp/logout` | `serverName` | Forgets the tokens and the registered client, reconnects; same result |

Clients should only open `http(s)` URLs from `auth_url`: the address comes
from the MCP server's metadata.

### Workspace trust

| Method | Params | Result |
|---|---|---|
| `_nova/workspace/trust` | `cwd`, `trusted?` (no session id needed) | `{ trusted, needsTrust }`. Trust lets the workspace's `.nova-ai` allow rules apply and its MCP servers start (from the next session); remembered in `~/.nova-ai` (see NOVA_HOME.md). Without `trusted` it only reports; `needsTrust` is true when the workspace is untrusted and declares MCP servers or allow rules |

### Background jobs

Jobs: `{ jobId, sessionId, kind: "terminal" | "prompt", title, status:
"running" | "completed" | "failed" | "killed" | "released", createdAt,
updatedAt, terminalId?, outputPath?, exitCode?, signal?, error? }`.

| Method | Params | Result |
|---|---|---|
| `_nova/background/start_terminal` | `command`, `title?` | `{ job }`; runs through the client's `terminal/create` |
| `_nova/background/start_prompt` | `prompt`, `title?` | `{ job }`; another agent turn in the background |
| `_nova/background/list` | `sessionId?` (no session id needed) | `{ jobs }` |
| `_nova/background/output` | `jobId` | `{ job, output, truncated, outputPath? }` |
| `_nova/background/kill` | `jobId` | `{ job }` |
| `_nova/background/release` | `jobId` | `{ job }` |

Notification `_nova/background/update`: `{ event, job, … }` with `event` one
of `started`, `event`, `completed`, `failed`, `killed`, `released`. Output is
also written under `~/.nova-ai/background-jobs/`.

### `_meta` keys

| Where | Key | Meaning |
|---|---|---|
| `session/new` / `load` / `resume` / `fork` params | `nova-ai-cli/settings` | Session settings (see Sessions) |
| `session/prompt` params | `nova-ai-cli/model` | Model for this prompt only |
| `session/prompt` params | `nova-ai-cli/effort` | Thinking level for this prompt only (over `thought_level`) |
| `session/new` / `load` / `resume` / `fork` params | `nova-ai-cli/workspaceMcp` | `false`: don't start the workspace's own MCP servers |
| `session/new` / `load` / `resume` / `fork` result | `nova-ai-cli/mcp`, `nova-ai-cli/skills` | MCP servers (configured: `name`, `transport`, `url` or `command`, `args` and `env` names, never values; connected; failures, including configuration errors) and discovered skills |
| tool calls | `nova-ai-cli/tool`, `nova-ai-cli/permission`, `nova-ai-cli/replayed` | Tool name, policy decision, replayed from history |
| `providers/list` result | `nova-ai-cli/models` | Chat models: `id`, `name` (`null` when the gateway has none), `label`, `providerId`, `providerName`, `enabled`, `contextWindow` and `maxOutputTokens` (tokens, `null` when the gateway does not say), `imageInput`, `efforts` (levels, lowest first; empty without), `reasoningDefault` (`"on"`, `"off"` or `null`), `thinking` (has levels or thinks at a fixed depth) |

## Unstable SDK features

`providers/list`, `providers/set`, `providers/disable` expose Nova's
providers. Next Edit Suggestions (`nes/start`, `nes/suggest`, `nes/accept`,
`nes/reject`, `nes/close` and the `document/*` notifications) predict the next
edit from the open buffer, recent edits and diagnostics;
`NOVA_NES_MODEL` selects a separate, faster model. Both follow the SDK's
unstable API and may change with it.

## Errors

| Situation | Error |
|---|---|
| Missing or rejected key | `authRequired` (-32000) |
| Unknown session | `resourceNotFound` (-32002) |
| Invalid params (bad session id, unknown mode or option) | `invalidParams` (-32602) |
| Unknown method | `methodNotFound` (-32601) |

Gateway errors include the request id that Nova returned.

## Testing a client

`NOVA_BASE_URL` points the agent at another OpenAI-compatible gateway, which
is how Nova's own conformance test (`packages/agent/tests/acp/conformance.test.ts`) runs
the real process against a local fake server.
