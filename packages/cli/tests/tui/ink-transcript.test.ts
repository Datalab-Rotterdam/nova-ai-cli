import assert from "node:assert/strict";
import test from "node:test";
import { Box, renderToString } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import { TranscriptBlockView } from "../../src/tui/ink/components/transcript.js";
import { StatusLine } from "../../src/tui/ink/components/status-line.js";
import { formatElapsedTime, formatTokenCount } from "../../src/tui/ink/format.js";
import {
  safeSplitOffset,
  TranscriptCommitter,
  type TranscriptBlock,
} from "../../src/tui/ink/transcript/committer.js";
import type { ToolCallView, UIMessage, UIState } from "../../src/tui/state/types.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const plain = (text: string) => text.replace(ANSI, "");

function state(patch: Partial<UIState> = {}): UIState {
  return {
    messages: [],
    plan: [],
    pendingPermission: null,
    pendingQuestion: null,
    inputHistory: [],
    busy: false,
    mode: "chat",
    permissionMode: "ask",
    interactionMode: "agent",
    sessionId: "test-session",
    cwd: "/workspace",
    statusLine: null,
    queuedCount: 0,
    contextUsage: null,
    updateAvailable: null,
    ...patch,
  };
}

function tool(id: string, patch: Partial<ToolCallView> = {}): UIMessage {
  return {
    id,
    role: "tool",
    call: {
      toolCallId: `call-${id}`,
      name: "read_file",
      kind: "read",
      mutating: false,
      args: { path: `src/${id}.ts` },
      status: "completed",
      output: "contents",
      diff: null,
      ...patch,
    },
  };
}

function renderBlocks(blocks: readonly TranscriptBlock[], columns = 80): string {
  return renderToString(
    createElement(
      Box,
      { flexDirection: "column" },
      blocks.map((block) =>
        createElement(Box, { key: block.key }, createElement(TranscriptBlockView, { block })),
      ),
    ),
    { columns },
  );
}

const kinds = (blocks: readonly TranscriptBlock[]) => blocks.map((block) => block.kind);

test("final messages are committed in order and streaming text stays live", () => {
  const committer = new TranscriptCommitter();
  const first = committer.sync(
    state({
      busy: true,
      messages: [
        { id: "u1", role: "user", text: "hello" },
        { id: "a1", role: "assistant", text: "Working on it", streaming: true },
      ],
    }),
    false,
  );
  assert.deepEqual(kinds(first.committed), ["header", "user"]);
  assert.deepEqual(kinds(first.live), ["assistant"]);

  const done = committer.sync(
    state({
      messages: [
        { id: "u1", role: "user", text: "hello" },
        { id: "a1", role: "assistant", text: "Working on it. Done.", streaming: false },
      ],
    }),
    false,
  );
  assert.equal(done.epoch, first.epoch, "appending never redraws the scrollback");
  assert.deepEqual(kinds(done.committed), ["header", "user", "assistant"]);
  assert.deepEqual(done.live, []);
  assert.notEqual(done.committed, first.committed, "<Static> needs a new array to notice growth");
});

test("completed paragraphs of a long streaming answer move to the scrollback", () => {
  const committer = new TranscriptCommitter();
  const text = "First paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nThird par";
  const snapshot = committer.sync(
    state({ busy: true, messages: [{ id: "a1", role: "assistant", text, streaming: true }] }),
    false,
  );
  const committedText = snapshot.committed
    .flatMap((block) => (block.kind === "assistant" ? [block.text] : []))
    .join("");
  assert.equal(committedText, "First paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n");
  const live = snapshot.live[0];
  assert.ok(live?.kind === "assistant");
  assert.equal(live.text, "Third par");
  assert.equal(live.first, false);

  const finished = committer.sync(
    state({
      messages: [{ id: "a1", role: "assistant", text: `${text}agraph.`, streaming: false }],
    }),
    false,
  );
  const last = finished.committed.at(-1);
  assert.ok(last?.kind === "assistant");
  assert.equal(last.text, "Third paragraph.");
  assert.equal(finished.live.length, 0);
});

test("a split never lands inside a fenced code block", () => {
  const text = "Intro\n\n```\nline\n\nmore\n";
  assert.equal(safeSplitOffset(text, 0), "Intro\n\n".length);
  assert.equal(safeSplitOffset("no blank line yet", 0), 0);
  assert.equal(safeSplitOffset("A\n\nB\n\nC", 3), "A\n\nB\n\n".length);
});

test("queued prompts and pending tools stay live; later final messages wait for them", () => {
  const committer = new TranscriptCommitter();
  const snapshot = committer.sync(
    state({
      busy: true,
      messages: [
        { id: "u1", role: "user", text: "edit it" },
        tool("e1", { name: "edit_file", kind: "edit", mutating: true, status: "pending" }),
        { id: "q1", role: "user", text: "and then this", queued: "followup" },
      ],
    }),
    false,
  );
  assert.deepEqual(kinds(snapshot.committed), ["header", "user"]);
  assert.deepEqual(kinds(snapshot.live), ["tool", "queued"]);
});

test("an activity group closes when the next message arrives or the turn ends", () => {
  const committer = new TranscriptCommitter();
  const reads = [tool("r1"), tool("r2")];
  const open = committer.sync(state({ busy: true, messages: reads }), false);
  assert.deepEqual(kinds(open.live), ["activity"], "more reads may still join the group");

  const closed = committer.sync(state({ busy: false, messages: reads }), false);
  assert.deepEqual(kinds(closed.committed), ["header", "activity"]);
  const group = closed.committed[1];
  assert.ok(group?.kind === "activity");
  assert.equal(group.calls.length, 2);
});

test("a rewind, another session, or verbose tools start a new epoch", () => {
  const committer = new TranscriptCommitter();
  const messages: UIMessage[] = [
    { id: "u1", role: "user", text: "one" },
    { id: "a1", role: "assistant", text: "two", streaming: false },
  ];
  const base = committer.sync(state({ messages }), false);

  const rewound = committer.sync(state({ messages: messages.slice(0, 1) }), false);
  assert.equal(rewound.epoch, base.epoch + 1);
  assert.deepEqual(kinds(rewound.committed), ["header", "user"]);

  const verbose = committer.sync(state({ messages: messages.slice(0, 1) }), true);
  assert.equal(verbose.epoch, rewound.epoch + 1);

  const other = committer.sync(state({ sessionId: "other", messages: [] }), true);
  assert.equal(other.epoch, verbose.epoch + 1);
  assert.deepEqual(kinds(other.committed), ["header"]);
});

test("a background job that finishes after it was printed gets a new line", () => {
  const committer = new TranscriptCommitter();
  const job = { jobId: "j1", kind: "terminal" as const, title: "npm test", preview: "" };
  committer.sync(
    state({ messages: [{ id: "b1", role: "background", job: { ...job, status: "running" } }] }),
    false,
  );
  const finished = committer.sync(
    state({ messages: [{ id: "b1", role: "background", job: { ...job, status: "completed" } }] }),
    false,
  );
  assert.deepEqual(kinds(finished.committed), ["header", "background", "background"]);
  assert.match(plain(renderBlocks(finished.committed.slice(1))), /npm test \[running\][\s\S]*npm test \[completed\]/);
});

test("the plan updates live during a turn and is printed once when it ends", () => {
  const committer = new TranscriptCommitter();
  const plan = [
    { content: "Inspect", priority: "high" as const, status: "completed" as const },
    { content: "Fix", priority: "high" as const, status: "in_progress" as const },
    { content: "Test", priority: "low" as const, status: "pending" as const },
  ];
  const during = committer.sync(state({ busy: true, plan }), false);
  assert.deepEqual(kinds(during.live), ["plan"]);

  const after = committer.sync(state({ busy: false, plan }), false);
  assert.deepEqual(kinds(after.committed), ["header", "plan"]);
  assert.deepEqual(after.live, []);
  const again = committer.sync(state({ busy: false, plan, statusLine: "x" }), false);
  assert.deepEqual(kinds(again.committed), ["header", "plan"], "printed only once");

  const rendered = plain(renderBlocks(after.committed.slice(1)));
  assert.match(rendered, /Tasks \(1\/3\)/);
  assert.match(rendered, /\[✓\] Inspect/);
  assert.match(rendered, /\[ \] Test/);
});

test("markdown wraps inside the terminal width", () => {
  const rendered = renderBlocks(
    [
      {
        key: "a",
        kind: "assistant",
        first: true,
        streaming: false,
        text: "# Heading\n\nA long paragraph with **bold text**, a [link](https://example.com), and Unicode ✦ 漢字.\n\n- one\n- two\n\n```ts\nconst answer = 42;\n```",
      },
    ],
    32,
  );
  const lines = plain(rendered).split("\n");
  assert.ok(lines.some((line) => line.includes("Heading")));
  assert.ok(lines.some((line) => line.includes("漢字")));
  assert.ok(lines.some((line) => line.includes("• one")));
  assert.ok(lines.some((line) => line.includes("const answer = 42;")));
  assert.ok(lines.every((line) => stringWidth(line) <= 32), lines.join("\n"));
});

test("long paragraphs and list items never run past the terminal edge", () => {
  const sentence =
    "Instead, she used the scent of rain on dry earth, the sound of a first laugh, and the warmth of a hearth fire.";
  const blocks: TranscriptBlock[] = [
    { key: "a", kind: "assistant", first: true, streaming: false, text: `${sentence} ${sentence}` },
    {
      key: "b",
      kind: "assistant",
      first: false,
      streaming: false,
      text: `- item ${sentence}\n- [x] task ${sentence}\n\n1. step ${sentence}\n   - nested ${sentence}`,
    },
    { key: "c", kind: "user", text: sentence },
  ];
  for (const columns of [40, 63, 80, 115]) {
    const lines = plain(renderBlocks(blocks, columns)).split("\n");
    const tooWide = lines.filter((line) => stringWidth(line) > columns);
    assert.deepEqual(tooWide, [], `at ${columns} columns`);
  }
});

test("read and search tools collapse into one activity line", () => {
  const committer = new TranscriptCommitter();
  const snapshot = committer.sync(
    state({
      messages: [
        tool("list", { name: "list_directory", kind: "search", args: { path: "src" } }),
        tool("a"),
        tool("b"),
      ],
    }),
    false,
  );
  const rendered = plain(renderBlocks(snapshot.committed.slice(1), 60));
  assert.match(rendered, /Read 2 files, listed 1 directory/);
  assert.match(rendered, /src\/a\.ts/);
  assert.match(rendered, /src\/b\.ts/);
  assert.doesNotMatch(rendered, /Output:/);

  const verbose = committer.sync(
    state({
      messages: [
        tool("list", { name: "list_directory", kind: "search", args: { path: "src" } }),
        tool("a"),
        tool("b"),
      ],
    }),
    true,
  );
  const expanded = plain(renderBlocks(verbose.committed.slice(1), 60));
  assert.doesNotMatch(expanded, /Read 2 files/);
  assert.match(expanded, /read_file: src\/a\.ts/);
  assert.doesNotMatch(expanded, /Output:/, "read tools stay compact in verbose mode");
});

test("an activity block shows a rolling three-row preview of shell output", () => {
  const rendered = plain(
    renderBlocks([
      {
        key: "g",
        kind: "activity",
        calls: [
          (tool("r1", { args: { path: "src/old.ts" } }) as Extract<UIMessage, { role: "tool" }>).call,
          ...["one", "two"].map(
            (name, index) =>
              (
                tool(name, {
                  name: "run_command",
                  kind: "execute",
                  mutating: true,
                  args: { command: `command-${name}` },
                  status: "pending",
                  output: index === 0 ? "old output\nfirst visible" : "second visible\nthird visible",
                }) as Extract<UIMessage, { role: "tool" }>
              ).call,
          ),
        ],
      },
    ]),
  );
  assert.match(rendered, /Reading 1 file, running 2 shell commands/);
  assert.match(rendered, /^\s+⎿ {2}first visible$/m);
  assert.match(rendered, /second visible/);
  assert.match(rendered, /third visible/);
  assert.doesNotMatch(rendered, /src\/old\.ts|old output/);
});

test("failed tools show their reason", () => {
  const rendered = plain(
    renderBlocks([
      {
        key: "f",
        kind: "activity",
        calls: [
          (tool("missing", { status: "failed", output: "ENOENT: file does not exist" }) as Extract<
            UIMessage,
            { role: "tool" }
          >).call,
        ],
      },
    ]),
  );
  assert.match(rendered, /Error: ENOENT: file does not exist/);
});

test("file edits render only added and removed lines, collapsed after 40", () => {
  const call = (
    tool("edit", {
      name: "edit_file",
      kind: "edit",
      mutating: true,
      output: "Updated src/example.ts.",
      diff: {
        path: "src/example.ts",
        oldText: "unchanged before\nold value\nunchanged after\n",
        newText: "unchanged before\nnew value\nunchanged after\n",
      },
    }) as Extract<UIMessage, { role: "tool" }>
  ).call;
  const rendered = plain(renderBlocks([{ key: "e", kind: "tool", call, expanded: false }]));
  assert.match(rendered, /- old value/);
  assert.match(rendered, /\+ new value/);
  assert.doesNotMatch(rendered, /unchanged before|unchanged after|Updated src\/example\.ts/);

  const big = {
    ...call,
    diff: { path: "big.txt", oldText: "", newText: Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") },
  };
  const collapsed = plain(renderBlocks([{ key: "b", kind: "tool", call: big, expanded: false }]));
  assert.match(collapsed, /\+ line 39/);
  assert.doesNotMatch(collapsed, /\+ line 40/);
  assert.match(collapsed, /… 10 more changed lines/);
  const full = plain(renderBlocks([{ key: "b", kind: "tool", call: big, expanded: true }]));
  assert.match(full, /\+ line 49/);
});

test("queued prompts render with their kind", () => {
  const rendered = plain(
    renderBlocks([
      { key: "q", kind: "queued", text: "follow up", queued: "followup" },
      { key: "s", kind: "queued", text: "steer now", queued: "steer" },
    ]),
  );
  assert.match(rendered, /queued> follow up/);
  assert.match(rendered, /steer> steer now/);
});

test("status shows model, modes and counts on one row, with messages and updates above it", () => {
  const ui = state({
    busy: true,
    queuedCount: 2,
    statusLine: "Request canceled.",
    contextUsage: {
      totalTokens: 12_345,
      contextWindow: 128_000,
    } as UIState["contextUsage"],
    updateAvailable: { currentVersion: "1.0.0", latestVersion: "1.1.0", tag: "latest", command: "npm i -g @datalabrotterdam/nova-ai-cli" },
  });
  const rendered = plain(
    renderToString(
      createElement(StatusLine, {
        ui,
        model: "nova-large",
        mcp: { configured: 2, connected: 1, failed: 1, skills: 3 },
      }),
      { columns: 120 },
    ),
  );
  const lines = rendered.split("\n");
  assert.match(lines[0]!, /Update 1\.1\.0 available \(current 1\.0\.0\)\. Run: npm i -g/);
  assert.equal(lines[1], "Request canceled.");
  assert.equal(
    lines[2],
    "nova-large | agent | ask | working | ctx:12k/128k | queued:2 | mcp:1/2 !1 | skills:3",
  );
});

test("an update nova-ai can install itself points at /update", () => {
  const rendered = plain(
    renderToString(
      createElement(StatusLine, {
        ui: state({
          updateAvailable: {
            currentVersion: "1.0.0",
            latestVersion: "1.1.0",
            tag: "latest",
            command: "npm install -g @datalabrotterdam/nova-ai-cli@latest",
            installable: true,
          },
        }),
        model: "nova-large",
        mcp: { configured: 0, connected: 0, failed: 0, skills: 0 },
      }),
      { columns: 120 },
    ),
  );
  assert.match(rendered.split("\n")[0]!, /Update 1\.1\.0 available \(current 1\.0\.0\)\. Type \/update to install it\./);
});

test("elapsed time and token counts format compactly", () => {
  assert.equal(formatElapsedTime(0), "0s");
  assert.equal(formatElapsedTime(61_000), "1m 1s");
  assert.equal(formatElapsedTime(3_726_000), "1h 2m 6s");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1_500), "1.5k");
  assert.equal(formatTokenCount(12_345), "12k");
  assert.equal(formatTokenCount(2_000_000), "2m");
});
