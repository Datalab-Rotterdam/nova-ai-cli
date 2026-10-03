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
  credentials.json              CLI only: API key + default model
  model-capabilities.json       CLI only: learned native tool-call support
  background-jobs/              CLI only: background job transcripts
  sessions/<id>.jsonl           CLI only, legacy: sessions from before projects/
  projects/<slug>-<hash8>/      one folder per workspace (see "Project key")
    project.json                where the folder came from
    MEMORY.md                   project memory index (always in the prompt)
    memory/<name>.md            project memory notes
    sessions/                   extension: chat panel sessions (index.json + <id>.json)
    cli-sessions/<id>.jsonl     CLI: sessions
    scratch/                    extension: scratch files (pruned after 7 days)
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
6,000 characters, the prompt suggests consolidating it.

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
