# Nova AI CLI — Terminal User Interface (TUI)

## Overview

The TUI is the interactive terminal client for `@datalabrotterdam/nova-ai-cli`. It is a **pure client of the ACP layer** — all agent interaction goes through the `NovaAgent` ACP surface (`src/acp`). The TUI never calls SDKs or tools directly; it translates ACP events into UI state and renders components as pure functions of that state.

The TUI lives under `src/tui/` and is designed to be rendering-library-agnostic. Its architecture enforces a strict separation:

```
┌─────────────────────────────────────────────┐
│ TUI process                                  │
│                                               │
│  Render layer (component tree)               │
│         │                                    │
│  UI state store (single source of truth)     │
│         │                                    │
│  ACP client adapter                          │
│    (session updates, permission requests,    │
│     tool-call events, background events)     │
│         │                                    │
└─────────┼─────────────────────────────────────┘
          │ ACP (stdio/JSON-RPC)
          ▼
    NovaAgent (src/acp)
```

---

## Feature Checklist

### 2.1 Session Lifecycle
- Start new session, resume/load past session, session switcher
- Session persistence indicator (saved/dirty), cwd and workspace root display
- Graceful close on exit, Ctrl-C, and process signals
- Single active session per TUI instance (v1); multi-session TBD

### 2.2 Conversation / Transcript
- Streaming assistant output (token-by-token or chunked) with mid-stream cancel
- Distinct rendering for user / assistant / error / tool / background messages
- Markdown rendering: headings, lists, code fences with syntax highlighting, links, tables
- Scrollback: keyboard scroll, mouse wheel, page up/down, jump to top/bottom
- Message virtualization and height caching for smooth scroll on long transcripts
- Copy-friendly output (no terminal rendering artifacts)
- Collapsible tool-call and long-output blocks

### 2.3 Input
- Multi-line text input (soft newline vs submit distinguished)
- Input history with up/down recall, persisted across sessions
- `@file` mention autocomplete (fuzzy, workspace-aware)
- `/slash` command autocomplete and built-in commands (`/help`, `/clear`, `/model`, `/sessions`, `/permissions`, `/background`, `/quit`, etc.)
- Bracketed paste handling (large pastes don't flood input)
- Queued-message indicator when submitting while agent is busy
- Interrupt/cancel current turn (e.g. Esc or Ctrl-C)

### 2.4 Tool Calls & Diffs
- Generic tool-call renderer driven by `ToolDefinition.kind`, with specialized views for: bash/run-command, file edit (diff view), search, read/list, background start
- Unified diff view for file edits with additions/deletions and syntax awareness
- Tool result truncation with "show more" for large outputs
- Visual distinction between mutating and read-only tools

### 2.5 Permissions
- Per-tool permission prompt dialog (bash command preview, edit diff preview, search query preview, generic fallback)
- Scope selection UI (once / session / always)
- Permission mode switcher (`ask` / `acceptEdits` / `bypassAll`) with visible indicator
- Interaction mode switcher (`plan` / `ask` / `agent`) with visible indicator

### 2.6 Background Jobs
- List running and completed background jobs (shell + sub-agent prompt jobs)
- Live-tail output of a selected background job
- Kill and release job actions
- Inline transcript markers when a background job starts, with shortcuts to detail view

### 2.7 Model & Config
- Model picker (list available models, switch mid-session)
- Workspace settings surface — read/display and editable via slash commands
- Theme selection (at least one default theme, structured for extensions)

### 2.8 Status & Chrome
- Persistent status line: cwd, active model, permission mode, interaction mode, MCP server connectivity, busy/idle state
- Banner/welcome view on startup (version, cwd, quick-start hint)
- Distinct error surface for connection errors, auth errors, and tool failures
- Full reflow on terminal resize, no stale layout

### 2.9 Auth & Startup
- Credential check on boot; triggers `auth-server.ts` OAuth flow if missing
- Login instructions/URL shown in-terminal
- Non-TTY detection with graceful fallback/error

### 2.10 Keybindings & Accessibility
- Documented, discoverable keybinding set (help overlay via `/help` or `?`)
- All destructive actions (kill job, clear session) require confirmation or undo window
- Avoid pure-color-only signaling (always pair color with text/symbol)

---

## Source Structure

```
src/tui/
  app.tsx          — main application component
  index.ts         — entry point (TTY check, bootstrap)
  svelte-preview.ts — Svelte preview runtime
  PLAN.md          — this design document
  commands/        — slash-command implementations
  components/      — renderable UI components
  files/           — file-related utilities and views
  hooks/           — React-like hooks for TUI state
  session/         — session management adapters
  settings/        — workspace settings surface
  state/           — UI state store and types
  svelte-app/      — Svelte application layer
  svelte-runtime/  — Svelte runtime bridge
  theme/           — theme definitions and selection
```

---

## Build Order (as planned)

1. Lock down state shape and ACP adapter contract
2. Pick rendering tech, stand up minimal render loop (banner + message list + input bar)
3. Streaming assistant messages + markdown rendering
4. Tool-call rendering (generic, then diff view)
5. Permission prompts + mode switching
6. Slash commands + file-mention autocomplete
7. Session switcher + persistence
8. Background jobs (list, tail, kill/release)
9. Model picker + settings surface
10. Status line, theming, resize handling, keybinding help overlay
11. TUI test harness + regression pass

---

## Open Decisions

1. **Rendering tech**: rebuild vendored custom renderer, adopt `ink`, blessed, or custom immediate-mode?
2. **Model listing**: does ACP need `listModels`/`setModel`, or does TUI get model info from config/SDK?
3. **Multi-session**: single vs tabbed/multiple concurrent sessions?
4. **State management**: hand-rolled store vs library?
5. **Testing strategy**: snapshot rendering? headless terminal driver?
