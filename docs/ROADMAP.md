# Roadmap: nova-ai-cli next to the VS Code extension

Status on 2026-10-25 (CLI `1.2.0-alpha.13`, agent `1.0.0-alpha.9`). What the CLI
and its ACP agent still lack compared with Nova AI for VS Code, and the smaller
loose ends. The extension keeps its own list in `nova-ai-vscode/docs/ROADMAP.md`.
Update this file as work lands.

## Still to do

### Parity with the extension

#### 1. `/rewind` that also undoes file changes
- **What:** checkpoints of the files Nova changed, so rewinding a turn can restore
  code as well as the conversation; per change Keep or Undo, like the extension's
  checkpoints (nova-ai-vscode #22).
- **Why:** `/rewind` now only takes back messages; the edits stay.

#### 2. `semantic_search`
- **What:** the extension's semantic code search (gateway embedding model,
  index in `projects/<key>/index/`: `chunks.json` + `vectors.f32`).
- **Before starting:** sharing that index is a change to the NOVA_HOME.md
  contract; agree on it with the extension side first (it is marked
  extension-only today).

#### 3. CI integration
- Listed in the extension's roadmap (phase 2): a GitHub Action and a GitLab
  template around `nova-ai -p --output-format json`.

### Smaller loose ends

- **Headless usage:** `nova-ai -p` reports no tokens or cost; add the session's
  `usageTotals` to its JSON output.
- **Click a row to expand it:** Ctrl+O expands thinking, command output and
  diffs all at once. Expanding one row by clicking it needs per-row state and
  hit-testing in the scrolled full-screen view.
- **Usage gaps:** with the text tool protocol, a stream cut short at a tool call
  reports no usage (marked `ponytail:` in `core/run-turn.ts`). A resumed session
  shows its totals from its first new request on.

## On hold

- **Chrome Web Store release of the browser extension** (nova-ai-browser): the
  store upload only runs when the repository variable `PUBLISH_CHROME_EXTENSION`
  is `true`, and the GitHub release no longer attaches the zip. The host package
  (`@datalabrotterdam/nova-ai-browser-host`) is released to npm as usual.
