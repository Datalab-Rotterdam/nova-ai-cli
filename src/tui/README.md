# Nova TUI

The interactive UI is built with [Ink](https://github.com/vadimdemedes/ink)
(React for the terminal). Nova keeps its own application state and talks to
`NovaAgent` over a real in-process ACP connection, the same protocol an editor
uses with `nova-ai --acp`.

This split is deliberate:

- `state/` is the UI source of truth.
- `session/tui-acp-client.ts` translates ACP requests and notifications.
- `session/session-runner.ts` coordinates the prompt lifecycle while the ACP
  session owns queued prompts, ordering, and steering.
- `commands/` defines the UI-independent slash-command surface.
- `ink/` is the view: React components plus the plain classes behind them.
  - `controller.ts` holds the behaviour (shortcuts, dialogs, commands, prompt
    submission) without React; `app.tsx` renders its `ViewState`.
  - `transcript/committer.ts` decides which transcript blocks are final.
  - `editor/` is the prompt editor (buffer, history, queue editing, pastes,
    autocomplete); `dialogs/state.ts` holds each dialog's keyboard logic and
    `dialogs/views.tsx` draws them.
  - `components/` has the transcript blocks, Markdown, prompt and status line.

## Interaction model

Nova renders inline, below the shell prompt, like `claude` or `codex`.
Finished transcript blocks are printed once with Ink's `<Static>` and become
ordinary terminal scrollback: scroll, search and copy them with the terminal's
own controls. Only the live area is redrawn: the answer that is still
streaming, running tools, queued prompts, the plan during a turn, the working
row, then the prompt (or an open dialog) and the status rows.

- Final blocks always form a prefix of the transcript. A long answer moves to
  the scrollback paragraph by paragraph (never inside a code block) while the
  rest streams, so the live area stays small.
- The live area is capped below the terminal height. Ink repaints the whole
  screen once a frame is as tall as the terminal, which would flicker and
  duplicate scrollback.
- When the printed history no longer matches (another session, `/clear`,
  `/rewind`, Ctrl+O), the screen and scrollback are cleared and the transcript
  is printed again.
- A background job that finishes after it was printed gets a new line; a plan
  is printed once when the turn ends.
- Dialogs (sessions, models, permission modes, background jobs, tool
  inspector, text panels, permission requests and questions) replace the
  prompt in the live area and are bounded by the terminal height.

The input is a multiline editor with a visible `> ` prompt, wrapping,
history, bracketed paste, slash-command autocomplete, and `@file` completion
(via `fd` when installed, respecting `.gitignore`). Enter submits;
submitting while a response streams appends a visible entry to the FIFO prompt
queue. `/steer <message>` also appears immediately, then enters the active turn
at the next safe model boundary after a tool finishes instead of cancelling the
response. Pending entries stay at the bottom of the transcript while new agent
output is inserted above them. With an empty editor, Up recalls the newest
queued entry; Up/Down cycle queued entries, edits update them in place, and
submitting an empty recalled entry removes it. `/queue` and `/queue clear`
inspect or clear pending messages.
Alt+Enter, Ctrl+J or a trailing `\` before Enter inserts a newline;
Shift+Enter does too in terminals with the kitty keyboard protocol (kitty,
WezTerm, Ghostty, foot, Alacritty; set `NOVA_KITTY_KEYBOARD=1` or `0` to
override). Ink's own protocol probe is not used because it delivers keys typed
during the probe twice.

Large clipboard pastes (more than 10 lines or 1,000 characters) stay outside
the editor and appear as a compact `[Pasted from clipboard #N: ...]` marker.
The transcript keeps that marker while the complete pasted text is sent to the
model. Smaller pastes remain inline.

After startup, the TUI checks npm for a newer published version in the
background. When one is available, a pinned footer banner shows both versions
and tells the user to run
`npm install -g @datalabrotterdam/nova-ai-cli@latest`. Registry errors and
timeouts are ignored so the check never blocks or interrupts the session.

Alt+V reads an image from the system clipboard and inserts a lightweight
`[#ImageN]` marker at the cursor. The binary PNG stays outside the editor and
is sent as an ACP image block, including when the prompt is queued. Paste and
submission are both gated by the selected model's advertised image-input
capability; an unsupported model leaves the draft untouched. Windows uses the
built-in clipboard API, macOS uses AppKit, and Linux supports `wl-paste` or
`xclip`. Images are limited to 10 MiB.

File mentions resolve directly against the workspace rather than depending on
the autocomplete index. Slash and backslash separators, `./`, quoted paths,
and files beyond the completion scan cap are supported; traversal outside the
workspace is rejected.

Collapsed read, search, and foreground shell calls render as one activity
block. Its heading aggregates the work (for example, `Reading 1 file, running
2 shell commands…`) and the body rolls through only the three newest paths or
terminal-output lines. Terminal output is coalesced into the pending tool call
while the process runs so frequent writes do not force a repaint per chunk.
An animated Nova marker identifies active work without repainting the whole
screen. The working row shows the live elapsed time and `esc to interrupt`
hint. It moves into the activity heading while a tool runs, then disappears as
soon as the response settles. Canceled and unexpectedly failed requests
mark every remaining pending tool as failed, and collapsed rows keep the final
error reason visible.

For multi-step work the agent uses `update_plan` to publish a standard ACP
`plan` update. During the turn the latest checklist stays in the live area
with completed, active, and pending markers (the active marker animates); each
update replaces it in place. When the turn ends, the final checklist is
printed to the scrollback once.

| Key                              | Action                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| Shift+Tab                        | Cycle agent / ask / plan mode                                                           |
| Escape                           | Cancel active work                                                                      |
| Ctrl+C twice                     | Cancel, then exit with a resume command                                                 |
| Ctrl+O                           | Expand or collapse verbose inline tool/background details; activity blocks stay compact |
| Ctrl+T                           | Open the tool inspector                                                                 |
| Ctrl+B                           | Inspect background shells and agents                                                    |
| Ctrl+R                           | Switch session                                                                          |
| Ctrl+P                           | Switch model                                                                            |
| Ctrl+K                           | Switch permission mode                                                                  |
| Alt+V                            | Paste a clipboard image when supported by the selected model                            |
| Up / Down                        | Earlier prompts; with an empty prompt, queued messages first                            |
| Tab                              | Accept a suggestion, or complete a path                                                 |
| Ctrl+A / Ctrl+E / Ctrl+U / Ctrl+W | Line start / end, delete to line start, delete word                                    |

Ctrl+O re-prints the transcript with verbose tool output (diffs longer than
40 changed lines are shortened otherwise).

The tool inspector is an accordion-style live view. Use Up/Down
to select a call; Enter, Space, Left, or Right to expand/collapse its arguments,
diff, and output; and Page Up/Down to scroll long details. `/tools` opens the
same inspector.

Interaction modes and permission modes are separate security domains. The
agent can call the argument-free `enter_plan_mode` tool to move itself from
`agent` to `plan`; this is a one-way least-privilege transition. The call
immediately blocks later tools in the current turn, and `ask`/`plan` turns are
started without any tools. Mode state is exposed through standard ACP session
modes and `current_mode_update` notifications.

The agent cannot change the permission mode. Only the user-facing Ctrl+K and
`/permission` controls can select `ask`, `acceptEdits`, or `bypassAll`, and
`bypassAll` is never accepted as an ACP interaction mode or read from a
settings file.

The same views are discoverable through `/tools`, `/agent`, `/shell`, `/mcp`,
`/session` (`/sessions` is an alias), `/model`, and `/permission`; queue control
uses `/queue` and `/steer`. `/rewind [count]` removes completed turns from both
the visible transcript and model history, and clears queued work so prompts
created against the discarded state cannot run. `/skills` shows skills discovered from `.agents/skills`,
`.claude/skills`, and `.codex/skills` in the user profile and workspace. The
agent receives their metadata and loads matching instructions on demand with
the safe `load_skill` tool.

The session picker renders each entry as `<time-ago> <prompt> <datetime>`.
Prompts stay on one width-truncated line, while the final column keeps the full
UTC ISO timestamp so older relative values such as `6w ago` remain exact.

`/compact` summarizes older conversation messages into durable context while
preserving the recent exchange. The same compaction runs automatically when
Nova returns a maximum-context or `input_tokens` overflow, after which the
interrupted model round is retried once. Compacted history is persisted as a
reset marker, so resuming the session does not reload discarded messages.
Compaction also starts a new rewind-checkpoint epoch. Completed prompts after
that point are stored as append-only turn records; `/rewind` appends a reset
record without erasing the earlier audit log.

The status row shows compact estimated context usage as `ctx:used/window`.
`/usage` opens the bordered breakdown for system instructions, conversation,
agent output, thinking before tool calls, tools, skills, and the total. Counts
are model-independent estimates because Nova models can use different
tokenizers; the context-window size comes from the active model metadata.

## Interactive questions

The `ask_user` tool uses ACP form elicitation to pause a turn and show a
bordered question dialog. A request may contain 1-4 questions. Each question
can be `single` or `multiple`, has optional context, and accepts 2-6 options
with optional descriptions. Set `recommended: true` on at most one option to
label it as recommended without choosing it automatically.

Every question receives a final `Other...` option. It opens an input with a
cursor so the user can provide their own answer; on multiple-choice questions,
that answer is combined with any checked options. Escape cancels the request.
ACP editor clients receive the same standard `elicitation/create` form when
they advertise `clientCapabilities.elicitation.form`.

```json
{
  "message": "Choose the implementation direction.",
  "questions": [
    {
      "id": "framework",
      "question": "Which framework should we use?",
      "description": "This determines the component architecture.",
      "type": "single",
      "options": [
        {
          "id": "svelte",
          "label": "Svelte",
          "description": "Continue the current implementation.",
          "recommended": true
        },
        { "id": "react", "label": "React" }
      ]
    }
  ]
}
```

## Permissions

The agent enforces the policy; the TUI only shows its questions. The full
contract (files, trust, rule syntax) is in `docs/NOVA_HOME.md`. In short:
rules use a `Tool(pattern)` form where `*` matches any text and `?` one
character; deny rules win, also in `bypassAll` mode and for read-only tools.
Allow rules from the repository (`.nova-ai/settings.json`,
`.nova-ai/settings.local.json`) only count once you trusted the workspace
(asked at startup when it declares rules or MCP servers, or `/trust`). The
default permission mode comes from `~/.nova-ai/settings.json` or the private
`~/.nova-ai/projects/<key>/settings.json`, never from the repository.

```json
{
  "permissions": {
    "allow": ["Bash(npx tsc *)", "Bash(npm run *)", "Edit(src/**)"],
    "deny": ["Bash(npm publish*)", "Write(.env*)"]
  }
}
```

`Bash(...)` covers foreground commands, package scripts, and background shell
commands; a command line is checked per command (`a && b` needs both
allowed). `Write(...)` and `Edit(...)` match the workspace path. Native tool
names such as `run_command(...)` and MCP tool names are also accepted. A rule
without parentheses allows or denies every invocation of that tool. Choosing
`always` in the permission dialog saves an exact rule in the private
`~/.nova-ai/projects/<key>/settings.json`, outside the repository.

## MCP

Project-local MCP configuration can live in `.mcp.json` using the common
name-keyed format. MCP tools enter the same ACP tool registry and
permission/rendering flow as built-in tools.

```json
{
  "mcpServers": {
    "workspace-files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": {}
    },
    "shared-tools": {
      "type": "http",
      "url": "https://example.test/mcp",
      "headers": {}
    }
  }
}
```

Stdio entries may omit `type`; `http` and `sse` transports require a URL.
Set `disabled: true` or `enabled: false` to skip an entry. Invalid files and
individual invalid servers appear in `/mcp` without preventing valid servers
from connecting.

The existing `.nova-ai/settings.json` array format remains supported:

```json
{
  "permissionMode": "ask",
  "mcpServers": [
    {
      "name": "workspace-files",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": []
    },
    {
      "type": "http",
      "name": "shared-tools",
      "url": "https://example.test/mcp",
      "headers": []
    }
  ]
}
```

Servers the workspace declares only start once the workspace is trusted. The
two sources are merged by server name. A `.mcp.json` entry overrides a
same-named entry from `.nova-ai/settings.json`. The files are re-read when a
new or stored session is opened. Header and environment values are never shown
by the inspector. Use `/mcp` to inspect the configured transports.

## Adding UI behavior

Put agent behaviour in ACP, state transitions in the store/adapter, keyboard
logic in a plain class (`ink/controller.ts`, `ink/dialogs/state.ts`,
`ink/editor/`) and drawing in a small React component under `ink/`. Let Ink do
the layout: prefixes and indentation are `<Box>` columns, so wrapping follows
the terminal width. Use `SelectionDialog` for choices and `ScrollPanel` for
long output. A new transcript block kind needs a case in the committer (when is
it final?) and in `TranscriptBlockView`.

Tests: `tests/tui/ink-transcript.test.ts` (committer and rendered blocks via
`renderToString`), `ink-dialogs.test.ts` (`ink-testing-library`),
`ink-editor.test.ts`, `ink-app.test.ts` (the whole app on a headless xterm) and
the real-terminal scenario in `pty-runtime-e2e.test.ts`. Cover narrow widths,
long unbroken text, wide characters and expanded tool output.
