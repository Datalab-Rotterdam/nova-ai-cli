<div align="center">

<img src="./assets/logo.png" width="96" height="96" alt="Nova logo" />

# @datalab-rotterdam/nova-ai-cli

**CLI for DataLab Rotterdam's Nova AI — also speaks Agent Client Protocol**

[![npm version](https://img.shields.io/npm/v/@datalab-rotterdam/nova-ai-cli?style=flat-square&color=f96743)](https://www.npmjs.com/package/@datalab-rotterdam/nova-ai-cli)
[![npm downloads](https://img.shields.io/npm/dm/@datalab-rotterdam/nova-ai-cli?style=flat-square)](https://www.npmjs.com/package/@datalab-rotterdam/nova-ai-cli)
[![license](https://img.shields.io/npm/l/@datalab-rotterdam/nova-ai-cli?style=flat-square)](./LICENSE)
[![ACP](https://img.shields.io/badge/ACP-agent-blue?style=flat-square)](https://agentclientprotocol.com)
[![issues](https://img.shields.io/github/issues/Datalab-Rotterdam/nova-ai-cli?style=flat-square)](https://github.com/Datalab-Rotterdam/nova-ai-cli/issues)

Talk to DataLab Rotterdam's Nova AI from your terminal, or point your editor/IDE at it via [Agent Client Protocol](https://agentclientprotocol.com) — both modes share the same auth and run on [`@datalabrotterdam/nova-sdk`](https://www.npmjs.com/package/@datalabrotterdam/nova-sdk).

[npm](https://www.npmjs.com/package/@datalab-rotterdam/nova-ai-cli) · [Issues](https://github.com/Datalab-Rotterdam/nova-ai-cli/issues) · [ACP docs](https://agentclientprotocol.com)

</div>

> **⚠️ Work in progress.** ACP mode (`--acp`) is the only fully implemented mode today — agentic tool use, permissions, and session persistence all work there. Interactive terminal chat (no flags) and the standalone browser UI (`--web`) are stubs that print a "not built yet" message. Expect breaking changes before a 1.0.

---

## Installation

No install needed — run directly with `npx`:

```sh
npx @datalab-rotterdam/nova-ai-cli --setup   # store your Nova API key
npx @datalab-rotterdam/nova-ai-cli           # interactive chat (WIP, stub)
npx @datalab-rotterdam/nova-ai-cli --acp     # speak ACP over stdio (editors/IDEs) — fully working
npx @datalab-rotterdam/nova-ai-cli --web     # standalone browser UI (WIP, stub)
```

Or install globally / as a project dependency:

```sh
npm install -g @datalab-rotterdam/nova-ai-cli
```

**Requires:** Node.js >= 18, a [Nova AI](https://api.nova.datalabrotterdam.nl) API key.

---

## Overview

`nova-ai-cli` is a terminal client for Nova AI, in the same spirit as `claude`/`codex`. Pass `--acp` to run it in Agent Client Protocol mode, where it reads JSON-RPC requests from stdin and writes responses/notifications to stdout so any ACP-aware editor/IDE can drive it like any other coding agent — with tool calling, permission prompts, and persisted session history. Bare/`--web` modes are placeholders for now. All modes share the same stored credentials.

```sh
# 1. one-time setup — opens a browser page to verify the key against Nova AI and store it locally
npx @datalab-rotterdam/nova-ai-cli --setup

# 2. point your ACP client at this binary
npx @datalab-rotterdam/nova-ai-cli --acp
```

Most editors invoke `--acp` for you once configured as an agent — `--setup` is the one command you run by hand first.

**Status:** `--setup` and `--acp` (including tool calling and session persistence) are fully implemented. Interactive terminal chat (no flags) and `--web` are stubs — see the WIP note above.

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
npx @datalab-rotterdam/nova-ai-cli --setup
```

Overrides, no browser flow required:

| Env var | Purpose |
|---|---|
| `NOVA_API_KEY` | Skip stored credentials, use this key |
| `NOVA_MODEL` | Skip stored default model, use this model id |

A future version will swap this for real OAuth once DataLab Rotterdam ships an OAuth provider for Nova AI — same local server (`src/acp/auth-server.ts`), same lifecycle, just a different page/flow. Credential handling stays isolated in `src/acp/credentials.ts` either way.

---

## What it implements

| ACP method | Behavior |
|---|---|
| `initialize` | Returns protocol version + the `nova-api-key` agent auth method |
| `session/new` | Allocates a session id with in-memory history |
| `session/load` | Restores a previously-persisted session and replays its turns as `*_message_chunk` notifications |
| `session/list` | Lists stored sessions, optionally filtered by `cwd` |
| `authenticate` | Runs the local browser auth flow (`src/acp/auth-server.ts`) and resolves once a valid key is stored |
| `session/prompt` | Streams a `chat.completions.stream()` call, forwarding `agent_message_chunk` updates as text arrives; drives the tool-calling loop below |
| `session/cancel` | Aborts the in-flight Nova AI request via `AbortController` |

Only `text` and `resource_link` content blocks are read from prompts today — images/audio/embeddings supported by `nova-sdk` aren't wired up yet.

Sessions are persisted to disk (`src/acp/sessions.ts`) so `session/load` can rehydrate history, and a title is auto-derived from the conversation.

### Tool calling

While streaming a response, the agent watches for a fenced tool-call marker in the model's output (`src/acp/tools/marker.ts`). When one appears, it stops streaming text and instead:

1. Reports the pending call via `session/update` (`tool_call` with status `pending`).
2. Requests permission from the client for any **mutating** tool (`allow_once` / `reject_once`), via `session/request_permission`.
3. Executes the tool and reports the result/error via a `tool_call_update`.
4. Feeds the tool result back into the conversation and loops (up to 10 rounds per prompt) until the model produces a plain answer.

Built-in tools (`src/acp/tools/registry.ts`):

| Tool | Mutating | Behavior |
|---|---|---|
| `read_file` | No | Reads a file's contents, gated by client `fs.readTextFile` capability |
| `write_file` | Yes | Writes/overwrites a file, gated by client `fs.writeTextFile` capability — requires permission |
| `run_command` | Yes | Runs a shell command in the session's `cwd` — requires permission |

Tools are filtered per-session by the client's advertised `clientCapabilities`, so a client without filesystem support never sees `read_file`/`write_file` offered.

---

## Development

```sh
npm install
npm test      # tsc --noEmit + node --test on tests/
npm run build # builds the Svelte setup page, then tsc -> dist/
```

Releases are automated via `semantic-release` on push to `main` (see `.github/workflows/ci.yml`); commit messages drive version bumps.

---

## License

[Apache-2.0](./LICENSE) © DataLab Rotterdam
