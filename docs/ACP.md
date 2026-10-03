# Nova over the Agent Client Protocol

`nova-ai --acp` is an [Agent Client Protocol](https://agentclientprotocol.com)
agent: JSON-RPC 2.0 as newline-delimited JSON over stdin/stdout. This page is
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
    "Nova AI": { "command": "npx", "args": ["-y", "@datalabrotterdam/nova-ai-cli", "--acp"] }
  }
}
```

Run `nova-ai login` once, or let the client run one of the auth methods below.

## initialize

The agent answers with:

| Field | Value |
|---|---|
| `agentInfo` | `{ name: "nova-ai-cli", title: "Nova AI", version }` |
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
| `nova-login-terminal` | `terminal` | The client runs `nova-ai login --no-browser` in a terminal (hidden key input) |

Keys are stored in `~/.nova-ai/credentials.json` (mode 0600). A request that
needs Nova without credentials fails with `authRequired`.

## Sessions

| Method | Notes |
|---|---|
| `session/new` | Starts MCP servers (in parallel, 10 s timeout each; failures are reported, not fatal). Returns `modes` and `configOptions`. |
| `session/load` | Replays the stored conversation: user and agent text, and tool calls with their final status, diff and (truncated) output. |
| `session/resume` | Like load, without the replay. |
| `session/fork` | Copies a stored session under a new id. |
| `session/list` | 50 per page with an opaque `cursor`; optional `cwd` filter. |
| `session/close` / `session/delete` | Close cancels a running turn and stops the session's MCP servers; delete also removes the stored file. Background jobs keep running until killed or the agent exits. |
| `session/prompt` | One turn. Prompts for the same session are queued and run one after another. |
| `session/cancel` | Aborts the model request and running tools, answers pending permission requests as cancelled, marks open tool calls failed ("Cancelled"), then returns `stopReason: "cancelled"`. |
| `session/set_mode` | `agent`, `ask` or `plan` (see Modes). Permission modes are rejected here. |
| `session/set_config_option` | `permission_mode` and `model` (see below). |

Session ids are UUIDs; anything else is rejected with `invalidParams`.
Unknown sessions give `resourceNotFound`. Sessions are stored as JSONL under
`~/.nova-ai/projects/<project-key>/cli-sessions/` (see
[NOVA_HOME.md](./NOVA_HOME.md)).

### Modes

| Mode | Tools |
|---|---|
| `agent` | All tools, plus `enter_plan_mode` |
| `plan` | Read-only: `read_file`, `list_directory`, `search_text`, `memory_read`, `load_skill`, plus `ask_user` and `update_plan` |
| `ask` | None |

The model can move itself from `agent` to `plan` with `enter_plan_mode`
(reported as `current_mode_update`); it can never move to a less restricted
mode.

### Config options

| `configId` | Values |
|---|---|
| `permission_mode` | `default` (ask for every change), `acceptEdits` (file edits are accepted), `bypassPermissions` (everything is accepted; deny rules still apply). Set per session, never stored by the agent. |
| `model` | The chat models of the account (embedding and speech models are left out). Present when the model list can be fetched; `config_option_update` follows when it loads late. |

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
| `fs.readTextFile` / `fs.writeTextFile` | `read_file`, `list_directory`, `search_text` / `write_file`, `edit_file` (unsaved editor buffers are seen) |
| `terminal` | `run_command`, `run_package_script`, background commands: created with `cwd`, an output limit and a timeout, then killed |
| `elicitation.form` | `ask_user`: 1–4 questions, single or multiple choice, option descriptions, a recommended option and a free-text "Other" answer |

Without a capability the matching tools are not offered.

## Tool calling

Nova uses the gateway's native function calling (`tools` / `tool_calls`). For
models that reject it, it falls back to a text protocol and remembers that per
model in `~/.nova-ai/model-capabilities.json`. `NOVA_TOOL_PROTOCOL=native|text`
forces one. A turn ends after 64 tool rounds with `stopReason:
"max_turn_requests"`.

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
| `_nova/queue/update` | `id`, `text?`, `prompt?`, `editing?`, `expectedVersion?` | `{ updated, entries }`; refused on a version mismatch |
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
| `_nova/session/context_usage` | `contextWindow?`, `mode?` | Estimated tokens per category (system, conversation, agents, thinking, tools, skills, memory) and the total |

Notification `_nova/session/rewound`: `{ sessionId, removedCheckpoints,
remainingCheckpoints, messageCount }`. Rewind and compaction are refused while
a prompt runs. Session files are append-only; a rewind appends a reset record.

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
| `session/prompt` params | `nova-ai-cli/model` | Model for this prompt only |
| `session/new` / `load` result | `nova-ai-cli/mcp`, `nova-ai-cli/skills` | MCP servers (configured, connected, failures) and discovered skills |
| tool calls | `nova-ai-cli/tool`, `nova-ai-cli/permission`, `nova-ai-cli/replayed` | Tool name, policy decision, replayed from history |
| `providers/list` result | `nova-ai-cli/models` | Chat models with their provider |

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
is how Nova's own conformance test (`tests/acp/conformance.test.ts`) runs
the real process against a local fake server.
