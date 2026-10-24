# `~/.nova-ai` — shared layout for Nova tools

`nova-ai-cli` and the `nova-ai-vscode` extension share one home folder. This
document is the contract between them: both must read and write it exactly as
described here, so a user can switch between the terminal and VS Code without
losing memory, sessions or settings. Change it only together with both
implementations.

## Location

`$NOVA_AI_HOME` if set (the extension's `nova.home` setting takes precedence
there), otherwise `~/.nova-ai`. Directories are created `0700`, files `0600`.

```
~/.nova-ai/
  MEMORY.md                     global memory index (always in the prompt)
  memory/<name>.md              global memory notes
  skills/<name>/SKILL.md        global skills (see "Skills")
  agents/<name>.agent.md        global agents (see "Agents")
  commands/<name>.md            global slash commands (see "Commands"; subfolders: ns:name)
  settings.json                 user settings: permission rules, default mode
  mcp.json                      extension: user MCP servers (see "MCP servers")
  credentials.json              CLI only: API key + default model and thinking level
  model-capabilities.json       CLI only: learned native tool-call support
  update-check.json             CLI only: npm's latest versions (asked at most daily), skipped/snoozed update
  background-jobs/              CLI only: background job transcripts
  mcp-auth/<hash>.json          CLI only: OAuth tokens and registered client per MCP server (0600)
  sessions/<id>.jsonl           CLI only, legacy: sessions from before projects/
  projects/<slug>-<hash8>/      one folder per workspace (see "Project key")
    project.json                where the folder came from; "trusted"
    settings.json               private per-project settings (rules saved by "always allow")
    MEMORY.md                   project memory index (always in the prompt)
    memory/<name>.md            project memory notes
    sessions/                   extension: chat panel sessions (index.json + <id>.json)
    cli-sessions/<id>.jsonl     CLI: sessions
    cli-sessions/extension-import.json  CLI: panel chats already imported (see "Sessions")
    scratch/                    extension: scratch files (pruned after 7 days)
    worktrees/<id6>/            extension: git worktrees of coding agents (branch nova/<name>-<id6>)
    index/                      extension: semantic search index (chunks.json + vectors.f32, rebuilt when the embedding model changes)
<workspace>/.nova-ai/settings.json        team settings, committed
<workspace>/.nova-ai/settings.local.json  personal settings, git-ignored
<workspace>/.nova-ai/skills/<name>/SKILL.md  project skills, committed
<workspace>/.nova-ai/commands/<name>.md       project slash commands, committed
<workspace>/NOVA.md             team instructions, committed, read-only for Nova
<workspace>/AGENTS.md           team instructions, committed, read-only for Nova
```

Each tool only writes the folders marked for it, plus the shared memory
files and `project.json`.

## Project key

`<slug>-<hash8>`:

- `slug`: the workspace folder name, lower-cased, runs of characters outside
  `[a-z0-9._-]` replaced by `-`, repeated `-` collapsed, leading/trailing `-`
  and `.` removed, at most 40 characters (then trailing `-`/`.` removed again);
  `workspace` when empty.
- `hash8`: the first 8 hex characters of the SHA-256 of the normalized
  workspace path: `realpath` when it exists, normalized with the platform's
  path rules, trailing separators removed (except a Windows drive root), and
  lower-cased on Windows and macOS.

For a VS Code multi-root workspace saved as a `.code-workspace` file, the path
is that file and the name is its base name without the extension.

`project.json`:

```json
{ "path": "/abs/workspace", "name": "workspace", "createdAt": "…", "lastOpenedAt": "…" }
```

## Settings and trust

Every settings file has the same shape; writers keep keys they do not know:

```json
{ "permissions": { "allow": ["run_command(npm test)", "edit_file(src/*)"], "deny": ["read_file(.env)"] },
  "permissionMode": "acceptEdits" }
```

Sources, all merged:

| File | Deny rules | Allow rules | `permissionMode` |
|---|---|---|---|
| `~/.nova-ai/settings.json` | yes | yes | yes |
| `projects/<key>/settings.json` | yes | yes | yes (wins) |
| `<workspace>/.nova-ai/settings.json` | yes | trusted only | never |
| `<workspace>/.nova-ai/settings.local.json` | yes | trusted only | never |

- Deny always wins, also for read-only tools. A repository can never approve
  its own commands or pick its own mode: its allow rules count only once the
  user trusted the workspace, recorded as `"trusted": true` in `project.json`.
- "Always allow" saves an exact rule in `projects/<key>/settings.json` (outside
  the repository). Older extension versions wrote `settings.local.json`; it is
  still read.
- Modes: `default` (ask for every change), `acceptEdits` (file edits are
  accepted), `bypassPermissions` (everything is accepted). `bypassPermissions`
  is never stored; it must be chosen in each session. `memory_write` is always
  confirmed unless an allow rule names it.
- Trust also gates MCP servers the workspace declares (see "MCP servers"):
  they are only started in a trusted workspace.
- `webSearch.searxngUrl` in `~/.nova-ai/settings.json` (an http(s) URL) is the
  SearXNG server nova-ai-cli's `web_search` tries first; a client that sets
  its own (VS Code's `nova.webSearch.searxng`) overrides it.

### Hooks

Claude Code's format, under `hooks` in any of the settings files above
(merged; the workspace's two only in a trusted workspace, as a hook runs any
command). Read by the extension and by nova-ai-cli's agent (so by every ACP
client); each product keeps the key.

```json
{ "hooks": {
    "PreToolUse":  [{ "matcher": "run_command|Bash", "hooks": [{ "type": "command", "command": "./scripts/check-command.sh", "timeout": 30 }] }],
    "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx prettier --write \"$(jq -r .tool_input.file_path)\"" }] }],
    "Stop":        [{ "hooks": [{ "type": "command", "command": "npm test --silent >/dev/null 2>&1 || { echo 'Tests fail' >&2; exit 2; }" }] }] } }
```

- Events: `PreToolUse` (before the approval card), `PostToolUse` (after the
  tool ran), `UserPromptSubmit`, `SessionStart` (before a chat's first
  message), `Stop` (the agent wants to finish).
- `matcher` (tool events only) is a regular expression over the whole tool
  name; it also matches Claude Code's names (`Bash`, `Read`, `Edit`, `Write`,
  `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`, `TodoWrite`) for each
  product's own tools (`Write` is `create_file` in the extension and
  `write_file` in the CLI, `LS` is `list_dir`/`list_directory`, `TodoWrite`
  is `todo_write`/`update_plan`). Empty or `*` matches every tool.
- The hook runs in the workspace root with the event as JSON on stdin:
  `session_id`, `hook_event_name`, `cwd`, and `tool_name`, `tool_input`
  (with an absolute `file_path` when the tool has a `path`),
  `tool_response`, `prompt` or `stop_hook_active`. `NOVA_PROJECT_DIR` and
  `CLAUDE_PROJECT_DIR` hold the workspace root. Default timeout 60 seconds.
- Exit code 2 blocks: the tool call (stderr goes to the model), the message
  (stderr is shown), or stopping (stderr goes to the model, which continues;
  at most three times per answer). After a tool ran, stderr is feedback for
  the model.
- Exit code 0 may print JSON: `{"decision": "block", "reason": "…"}`,
  `{"decision": "approve"}`, `{"continue": false, "stopReason": "…"}`, or
  `hookSpecificOutput` with `permissionDecision` (`allow`/`deny`),
  `permissionDecisionReason` and `additionalContext`. Plain stdout of
  `UserPromptSubmit` and `SessionStart` hooks is added to the message as
  context. A PreToolUse `allow` skips the approval card; deny rules still win.
- Any other exit code is a warning in the chat; the call goes on.

### MCP servers

Claude's format, in these files (a later file replaces a server of the same
name):

| File | Scope | Read by |
|---|---|---|
| `~/.nova-ai/mcp.json` | the user's, every workspace | extension |
| `<workspace>/.mcp.json` | team, committed (also read by Claude Code) | both |
| `<workspace>/.nova-ai/mcp.json` | team, committed | extension |
| `mcpServers` in `<workspace>/.nova-ai/settings.json` | team, ACP format (`[{ name, command, args, env }]`) | CLI |

```json
{ "mcpServers": {
    "files":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "env": { "DEBUG": "1" } },
    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } },
    "remote": { "type": "http", "url": "https://mcp.example.com/mcp", "oauth": { "clientId": "…", "callbackPort": 33418 } } } }
```

- `type` is `stdio` (default when `command` is set), `http` (Streamable
  HTTP; default when `url` is set) or `sse`. The extension falls back from
  `http` to SSE; the CLI connects with the given type only.
- Extension: `${VAR}` and `${VAR:-default}` expand from the environment in
  `command`, `args`, `env`, `url` and `headers`. The CLI takes values as
  written.
- OAuth: servers that answer 401 are signed in to through the browser with a
  loopback redirect `http://127.0.0.1:<port>/callback`, from the extension's
  **Nova AI: MCP Servers** command or the CLI's `/mcp login <server>` (any
  ACP client: `_nova/mcp/login`). Nova registers itself (dynamic client
  registration) unless `oauth.clientId` is set; a client registered by hand
  needs a fixed `oauth.callbackPort`. Tokens never go in these files: the
  extension keeps them in the editor's secret storage, the CLI in
  `~/.nova-ai/mcp-auth/` (0600).
- Extension: `"disabledMcpServers": ["name"]` in `projects/<key>/settings.json`
  turns servers off for that workspace.
- Tools are named `mcp__<server>__<tool>` (outside `[A-Za-z0-9_-]` replaced by
  `_`; the extension cuts names at 64 characters). A rule `mcp__<server>` or
  `mcp__<server>__*` covers every tool of the server.

### Rules

`tool` matches every call of the tool, `tool(glob)` when the call's subject
matches the glob (`*` any text, `?` one character, `[*]`/`[?]` or `\*`/`\?`
literal). Subjects:

| Tool | Subject |
|---|---|
| `run_command`, `start_background_command` | the command line |
| `run_package_script` | `npm run <script> [-- args]` |
| `read_file`, `write_file`, `create_file`, `edit_file`, `list_directory`, `list_dir`, `search_text` | the path, workspace-relative with `/` (absolute outside the workspace) |
| `find_files` | the glob pattern |
| `fetch_url` | the URL |
| `web_search` | the query (CLI; the extension never asks for it) |
| `mcp__<server>__<tool>` | none; `mcp__<server>` or `mcp__<server>__*` matches every tool of the server |
| others | none: only the bare tool name matches |

Command rules are checked per command: a command line is split at `;`, `&&`,
`||`, `|`, `&` and newlines (outside quotes), a deny rule matching any part
denies the whole line, and an allow rule must match every part. Lines with
substitutions, subshells, heredocs or nested shells (`$( )`, backticks, `( )`,
`{ }`, `<<`, `sh -c`, …) are only allowed by a rule that matches the whole
line exactly. Rule names may also use the aliases `Bash` (command tools),
`Read`, `Write` and `Edit`; Nova itself always writes real tool names. Tools
that have a different name in the other product match each other's rules:
`write_file` = `create_file`, `list_directory` = `list_dir`, `update_plan` =
`todo_write`.

## Memory

Two scopes, `global` (about the user, all projects) and `project` (this
workspace only, kept outside the repository). Each scope has one index file
and any number of notes.

### `MEMORY.md` (index)

Markdown the user may edit freely. Created with this header:

```
# Nova memory (global)

Notes Nova keeps across all projects: your preferences, conventions and style.
Edit freely; Nova reads this file at the start of every chat.

```

(project: `# Nova memory (this project)` / `Private notes about this project,
kept outside the repository.` / `Edit freely; Nova reads this file at the start
of every chat in this workspace.`)

Entries are lines starting with `- ` or `* `. Nova writes two kinds:

- a fact: `- 2026-10-03: User prefers pnpm.` (dated, one line)
- a note link: `- [Release flow](memory/release-flow.md) — how releases are cut`

Any other lines are kept as written.

### Notes (`memory/<name>.md`)

For facts too long for one line. `name` matches
`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`; the file is:

```
---
name: release-flow
description: "how releases are cut"
type: project
---

<content, at most 32 KiB>
```

`type` is one of `user`, `feedback`, `project`, `reference` (unknown values
read as `reference`). `description` is one line of at most 240 characters.
Writing a note also writes or updates its link line in the scope's
`MEMORY.md`; deleting a note removes it. A project note hides a global note of
the same name.

### In the prompt

At the start of every turn, in this order: `NOVA.md` and `AGENTS.md` from each
workspace root, then project `MEMORY.md`, then global `MEMORY.md`, each without
its generated header, at most 8,000 characters per file and 16,000 in total.
Then the catalog of notes (name, type, scope, description); a note's content
is only read with the `memory_read` tool. Memory is context, never
instructions that override the user. When an index exceeds 40 entries or
6,000 characters, the prompt suggests consolidating it. With memory switched
off for a session (the extension's `nova.memory.enabled`, the agent's
`memory` session setting) none of this is in the prompt and the tools are not
offered.

### Tools

Both products expose the same two tools, so permission rules work the same:

- `memory_read` — `{ scope?: "global" | "project", name?: string }`: without
  `name`, the index file(s); with `name`, that note.
- `memory_write` — `{ action, scope, ... }`, mutating (needs approval unless
  allowed by a rule):
  - `remember` `{ text }`: append a dated fact (skipped if an equal one exists)
  - `replace` `{ match, text }` / `forget` `{ match }`: change/remove fact lines
    containing `match` (case-insensitive)
  - `rewrite` `{ text }`: replace all entries, one per line (consolidation);
    the header is kept
  - `save_note` `{ name, description, type, content }`: create or overwrite a note
  - `delete_note` `{ name }`

Writes are computed against the file as read and refused when it changed in
the meantime; files are replaced atomically (write to a temp file, rename).
Nova never writes `NOVA.md`/`AGENTS.md`, secrets, credentials or large raw
output to memory.

### Migration

- CLI ≤ 1.1: notes in `~/.nova-ai/memory/global/` move to `~/.nova-ai/memory/`;
  notes in `~/.nova-ai/memory/<name>-<sha256(path)[0:16]>/` move to the
  project's `memory/` the first time the CLI runs in that workspace. Moved
  notes get a link line in the matching `MEMORY.md`. A note whose target name
  already exists is left in place.
- The scope name `workspace` (CLI ≤ 1.1) is accepted as `project`, and the tool
  names `load_memory`/`save_memory` as `memory_read`/`memory_write`.

## Sessions

Each product writes only its own folder: the extension's chat panel
`projects/<key>/sessions/` (`index.json` plus `<id>.json`), the CLI and its
ACP agent `projects/<key>/cli-sessions/<id>.jsonl`. When the agent lists the
sessions of a workspace it imports the panel's chats it has not seen yet
(same id and title), so one history shows both; the ids it has imported are
kept in `cli-sessions/extension-import.json`, and the panel's files are not
changed.

## Skills

A skill is a folder with a `SKILL.md` and any files it refers to:

```
---
name: release-notes
description: "Write release notes from the merged pull requests"
---

<instructions>
```

`name` defaults to the folder name, `description` should say when to use it.
Skills are read from these folders, lowest priority first; a skill with the
same name in a later folder replaces the earlier one. Sub-folders are searched,
symbolic links are not followed.

| Scope | Folders |
|---|---|
| global | `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, then `$NOVA_AI_HOME/skills` |
| project | `<workspace>/.agents/skills`, `.claude/skills`, `.codex/skills`, then `<workspace>/.nova-ai/skills` |

Nova creates new skills in `$NOVA_AI_HOME/skills/<name>/` (global) or
`<workspace>/.nova-ai/skills/<name>/` (project). `name` for new skills
matches `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`.

Switching a skill off keeps its files: `"skills": { "disabled": ["name"] }` in
`~/.nova-ai/settings.json` (every workspace) or `projects/<key>/settings.json`
(this workspace). A name listed in either is off.

In the prompt only the list of skills that are on: name and description (at
most 160 characters each), within about 4,000 characters. When there are more,
the skills matching the user's message keep their description, others are listed
by name only (about 1,000 characters), the rest are counted. The model reads a
skill with `load_skill` (`{ name, resource? }`, at most 24,000 characters per
file, only files inside the skill's folder).

### Bundled skills

A Nova app may ship a skill and keep it up to date: a *bundled* skill. Examples:
`nova-docx`, `nova-xlsx`, `nova-pptx` and `nova-pdf` from
[nova-ai-skills](https://github.com/Datalab-Rotterdam/nova-ai-skills)
(`"bundledBy": "Nova AI Skills"`), which both Nova AI for VS Code and
nova-ai-cli's agent install at start-up, and `nova-browser`, installed by the
Nova AI Browser host they carry. Its folder holds `.nova-bundled.json`:

```json
{ "bundledBy": "Nova AI Browser", "version": "0.1.0", "hash": "<sha256 over the files>" }
```

- Users can only switch a bundled skill off (by name, as above). Every Nova tool
  must show it as bundled and must not offer to edit, move or delete it, and the
  agent's file tools refuse to change its files.
- The app that bundles it makes its files read-only and reinstalls it whenever
  the version or the content hash no longer matches (an update, or a local edit).
  The `disabled` setting is kept, so a switched-off skill stays off after updates.
- An installer never touches a skill folder without its own marker.
- Several apps carry nova-ai-skills, so its installer only replaces a copy from
  an older version (or an edited one) and leaves a newer one to the app that
  carries the newer package.
- nova-ai-cli's agent reports `bundledBy` in `_nova/skills/list` (`/skills`
  shows "bundled with …"), and its `write_file` and `edit_file` refuse the
  skill's files. It installs nova-ai-skills when a client connects.

## Commands

Slash commands as markdown files, in Claude Code's format: the file's text is the
prompt, sent as the user's message when they run `/<name> [arguments]`.

```markdown
---
description: Write tests for a file      # shown in the slash menu
argument-hint: <file>                    # shown after the name
model: <model id>                        # optional: that model for this answer only
---
Write unit tests for $ARGUMENTS in the style of the existing tests.
```

- Folders, a later one replacing a command of the same name:
  `~/.claude/commands` (only with the extension's `nova.skills.includeClaudeCodex`),
  `~/.nova-ai/commands`, then per workspace `.claude/commands` (same setting) and
  `.nova-ai/commands`.
- The name is the file name without `.md`, lower-cased; a file in a subfolder is
  `<folder>:<name>`. Names start with a letter or digit and use `[a-z0-9_:-]`.
- `$ARGUMENTS` is everything after the name, `$1`…`$9` single words; a file
  without placeholders gets the arguments appended after a blank line.
- `allowed-tools` is read by Claude Code; Nova ignores it for now.
- Built-in commands win a name clash. The extension also offers enabled skills as
  `/<skill-name>` and MCP prompts as `/mcp__<server>__<prompt>`.
- nova-ai-cli's agent reads the same files for every ACP client: it lists them
  in `available_commands_update` (read again after each turn) and expands a
  prompt that starts with `/<name>`. It always reads the `.claude/commands`
  folders, as it does `.claude/skills`; `model` must be a model of the account.

## Agents

An agent is a markdown file whose body is added to Nova's system prompt. The chat's
mode menu (and Shift+Tab) switches between the built-in agents (Interactive, Plan,
Autopilot, Ask) and your own. Put your own in `~/.nova-ai/agents/<name>.agent.md`
(all projects) or `~/.nova-ai/projects/<key>/agents/<name>.agent.md` (one project);
a project agent replaces a global one with the same file name. The built-in agents are bundled with the extension and cannot be replaced, edited or deleted (a file with a built-in name is ignored). **Nova AI: Manage Agents** lists, edits and deletes them.

```markdown
---
name: Reviewer
description: Reviews changes without editing
icon: eye            # a codicon name
tools: [read, search, web, ask]   # optional; omit for all tools
readOnly: true       # optional; only tools that change nothing
autopilot: false     # optional; no tool round limit, ask_user answers itself
---
Instructions for the agent.
```

Tool groups: `read`, `search`, `edit`, `run`, `web`, `memory`, `ask`, `todo`, `skills`,
and `mcp` for MCP tools; or list tool names such as `read_file`.

nova-ai-cli's agent reads the same files and offers each one as a session mode
after its built-in `agent`, `ask`, `plan` and `autopilot` (Shift+Tab and `/mode <id>` in the
CLI; the id is the file name, `Code Review.agent.md` → `code-review`). A file
named after a built-in mode is ignored. Differences from the extension:
- `icon` is not used. `autopilot: true` works as in the extension: up to 1,000
  tool rounds instead of the `maxToolRounds` setting, and `ask_user` answers
  itself; tool calls that need approval still wait for the user.
- The groups map to the agent's own tools (`edit` is `edit_file` and
  `write_file`, `todo` is `update_plan`, `run` includes the background
  commands); the extension's tool names (`list_dir`, `create_file`,
  `todo_write`, `spawn_agents`) are accepted too.
- The CLI's `/agent` command starts a background agent, which is something else.
