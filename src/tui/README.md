# Nova TUI foundation

The default interactive UI uses `@earendil-works/pi-tui`. Nova keeps its own
application state and talks to `NovaAgent` through the in-process ACP adapter;
the TUI library owns terminal input, width-aware rendering, differential
updates, synchronized output, focus, overlays, Markdown, and the editor.

This split is deliberate:

- `state/` is the UI source of truth.
- `session/tui-acp-client.ts` translates ACP requests and notifications.
- `session/session-runner.ts` owns session and prompt lifecycle.
- `pi-app/` contains presentation and keyboard interaction only.
- `commands/` defines the UI-independent slash-command surface.

## Interaction model

The app runs in the terminal's alternate screen and always renders exactly the
current terminal height. `FullscreenLayout` gives the transcript all rows not
used by the editor and status footer, with the status row rendered below the
input. The Nova AI workspace header is the first transcript content, so it is
visible at the top of history and scrolls away normally instead of consuming a
fixed viewport row. Selection dialogs replace the root layout while open instead of using
Pi's overlay compositor. This keeps their title at the first row and counter at
the last row. Navigation uses a synchronized full repaint, preventing the old
selection cursor or editor cells from surviving a scroll frame.
Pi's resize callback reads the new columns and rows, reflows every width-aware
component, and performs a full repaint. The transcript handles mouse-wheel,
Shift+Page Up/Down, and Ctrl+Home/End navigation. Bounded inspectors use a
separate scrollable overlay with arrows, Page Up/Down, Home, and End.

The input is a real multiline editor with a visible `> ` prompt, hardware
insertion cursor, wrapping, history, bracketed paste, undo, slash-command
autocomplete, and `@file` completion. Enter submits;
submitting while a response streams appends a visible entry to the FIFO prompt
queue. `/steer <message>` also appears immediately, then enters the active turn
at the next safe model boundary after a tool finishes instead of cancelling the
response. Pending entries stay at the bottom of the transcript while new agent
output is inserted above them. With an empty editor, Up recalls the newest
queued entry; Up/Down cycle queued entries, edits update them in place, and
submitting an empty recalled entry removes it. `/queue` and `/queue clear`
inspect or clear pending messages.
Shift+Enter or Ctrl+J inserts a newline.

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

| Key                              | Action                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| Shift+Tab                        | Cycle agent / ask / plan mode                                                           |
| Escape                           | Cancel active work                                                                      |
| Ctrl+C twice                     | Cancel, then exit with a resume command                                                 |
| Ctrl+O                           | Expand or collapse verbose inline tool/background details; activity blocks stay compact |
| Ctrl+T                           | Inspect full tool call details                                                          |
| Ctrl+B                           | Inspect background shells and agents                                                    |
| Ctrl+R                           | Switch session                                                                          |
| Ctrl+P                           | Switch model                                                                            |
| Ctrl+K                           | Switch permission mode                                                                  |
| Alt+V                            | Paste a clipboard image when supported by the selected model                            |
| Mouse wheel / Shift+Page Up/Down | Scroll transcript                                                                       |
| Ctrl+Home / Ctrl+End             | Jump to transcript top / bottom                                                         |

Interaction modes and permission modes are separate security domains. The
agent can call the argument-free `enter_plan_mode` tool to move itself from
`agent` to `plan`; this is a one-way least-privilege transition. The call
immediately blocks later tools in the current turn, and `ask`/`plan` turns are
started without any tools. Mode state is exposed through standard ACP session
modes and `current_mode_update` notifications.

The agent cannot change `permissionMode`. Only the user-facing Ctrl+K and
`/permission` controls can select `ask`, `acceptEdits`, or `bypassAll`, and
`bypassAll` is never accepted as an ACP interaction mode.

The same views are discoverable through `/tools`, `/agent`, `/shell`, `/mcp`,
`/session` (`/sessions` is an alias), `/model`, and `/permission`; queue control uses `/queue` and
`/steer`. `/skills` shows skills discovered from `.agents/skills`,
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

Project permission policy lives in `.nova-ai/settings.json`. Rules use a
Claude-style `Tool(pattern)` form; `*` matches any sequence and `?` matches one
character. `deny` is evaluated before `allow` and remains effective in
`bypassAll` mode. Unmatched mutating calls follow `permissionMode` (`ask`,
`acceptEdits`, or `bypassAll`). Read-only tools remain automatic.

```json
{
  "permissionMode": "ask",
  "permissions": {
    "allow": [
      "Bash(npx tsc *)",
      "Bash(npx tsup *)",
      "Bash(npm run *)",
      "Edit(src/**)"
    ],
    "deny": ["Bash(npm publish*)", "Write(.env*)"]
  }
}
```

`Bash(...)` covers foreground commands, package scripts, and background shell
commands. `Write(...)` and `Edit(...)` match their workspace path. Native tool
names such as `run_command(...)` and MCP tool names are also accepted. A rule
without parentheses allows or denies every invocation of that tool. Choosing
`always` in the permission dialog persists an exact argument-aware allow rule.

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

The two sources are merged by server name. A `.mcp.json` entry overrides a
same-named entry from `.nova-ai/settings.json`. The files are re-read when a
new or stored session is opened. Header and environment values are never shown
by the inspector. Use `/mcp` to inspect the configured transports.

## Adding UI behavior

Prefer a small `Component` in `pi-app/components.ts` whose `render(width)`
returns width-bounded rows. Put agent behavior in ACP, state transitions in the
store/adapter, and only view behavior in the component. Use `SelectionDialog`
for choices and `ScrollPanel` for long inspectable output.

Rendering regressions belong in `tests/tui/pi-components.test.ts`. Tests should
include narrow widths, long unbroken text, Unicode/wide characters, content
shrinking, and expanded tool output.
