import assert from "node:assert/strict";
import test from "node:test";
import { Key, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
  BorderedWindow,
  formatElapsedTime,
  FullscreenLayout,
  ScrollPanel,
  SelectionDialog,
  StatusView,
  TranscriptView,
} from "../../src/tui/pi-app/components.js";
import { createStore } from "../../src/tui/state/store.js";
import type { UIState } from "../../src/tui/state/types.js";

function state(): UIState {
  return {
    messages: [],
    pendingPermission: null,
    pendingQuestion: null,
    inputHistory: [],
    busy: false,
    mode: "chat",
    permissionMode: "ask",
    interactionMode: "agent",
    sessionId: "test-session",
    cwd: "C:\\workspace",
    statusLine: null,
    queuedCount: 0,
    contextUsage: null,
    updateAvailable: null,
  };
}

test("transcript renders wrapped markdown without exceeding the viewport", () => {
  const store = createStore(state());
  store.setState({
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        text: "# Heading\n\nA long paragraph with **bold text**, a [link](https://example.com), and Unicode ✦ 漢字.",
        streaming: false,
      },
    ],
  });
  const transcript = new TranscriptView(store);
  transcript.sync();

  const lines = transcript.render(32);
  assert.ok(lines.some((line) => line.includes("Heading")));
  assert.ok(lines.some((line) => line.includes("漢字")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 32));
});

test("transcript does not insert blank rows between timeline entries", () => {
  const store = createStore(state());
  store.setState({
    messages: [
      { id: "user-1", role: "user", text: "Inspect this" },
      {
        id: "tool-1",
        role: "tool",
        call: {
          toolCallId: "call-1",
          name: "read_file",
          kind: "read",
          mutating: false,
          args: { path: "src/index.ts" },
          status: "completed",
          output: "contents",
          diff: null,
        },
      },
      { id: "assistant-1", role: "assistant", text: "Done", streaming: false },
    ],
  });
  const transcript = new TranscriptView(store);
  transcript.sync();

  const lines = transcript.render(80);
  assert.equal(lines.length, 6);
  assert.ok(lines.every((line) => line !== ""));
});

test("working activity animates only while work remains active", () => {
  const store = createStore({ ...state(), busy: true });
  let now = 0;
  const transcript = new TranscriptView(store, () => now);
  transcript.sync();

  const first = transcript.render(60).join("\n");
  assert.match(first, /Working \(0s \u2022 esc to interrupt\)/);
  now = 142_000;
  assert.equal(transcript.advanceAnimation(), true);
  const next = transcript.render(60).join("\n");
  assert.notEqual(next, first);
  assert.match(next, /Working \(2m 22s \u2022 esc to interrupt\)/);

  store.setState({ busy: false });
  transcript.sync();
  assert.equal(transcript.advanceAnimation(), false);
  assert.doesNotMatch(transcript.render(60).join("\n"), /Working/);

  now = 200_000;
  store.setState({ busy: true });
  transcript.sync();
  assert.match(
    transcript.render(60).join("\n"),
    /Working \(0s \u2022 esc to interrupt\)/,
  );
});

test("elapsed working time formats compactly", () => {
  assert.equal(formatElapsedTime(-1), "0s");
  assert.equal(formatElapsedTime(12_999), "12s");
  assert.equal(formatElapsedTime(142_000), "2m 22s");
  assert.equal(formatElapsedTime(3_723_000), "1h 2m 3s");
});

test("Nova AI header is transcript content and scrolls with history", () => {
  const store = createStore(state());
  store.setState({
    messages: Array.from({ length: 12 }, (_, index) => ({
      id: `history-${index}`,
      role: "assistant" as const,
      text: `history message ${index + 1}`,
      streaming: false,
    })),
  });
  const transcript = new TranscriptView(store);
  transcript.sync();
  const layout = new FullscreenLayout(
    transcript,
    new Text("status", 0, 0),
    new Text("editor", 0, 0),
    () => 8,
    () => {},
  );

  const transcriptRows = transcript.render(60);
  assert.match(transcriptRows[0]!, /Nova AI/);
  assert.match(transcriptRows[1]!, /Workspace: C:\\workspace/);
  assert.equal(
    layout.render(60).some((line) => line.includes("Nova AI")),
    false,
  );

  layout.scrollToTop();
  assert.ok(layout.render(60).some((line) => line.includes("Nova AI")));
});

test("status renders as one row below the editor without a separator", () => {
  const store = createStore(state());
  store.setState({
    statusLine: "Request canceled.",
    contextUsage: {
      categories: {
        system: 100,
        conversation: 1_000,
        agents: 500,
        tools: 2_000,
        thinking: 250,
        skills: 150,
        memory: 0,
      },
      totalTokens: 4_000,
      contextWindow: 262_144,
      remainingTokens: 258_144,
      percentUsed: 1.52587890625,
      estimated: true,
    },
  });
  const status = new StatusView(store, "qwen3.6:27b", {
    configured: 0,
    connected: 0,
    failed: 0,
    skills: 38,
  });
  status.update(store.getState(), "qwen3.6:27b", {
    configured: 0,
    connected: 0,
    failed: 0,
    skills: 38,
  });

  const lines = status.render(100);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0]!,
    /qwen3\.6:27b.*agent.*ask.*ready.*ctx:4k\/262k.*skills:38.*Request canceled\./,
  );
  assert.doesNotMatch(lines[0]!, /─/);
});

test("status pins the available update and exact upgrade command", () => {
  const store = createStore(state());
  store.setState({
    updateAvailable: {
      currentVersion: "1.1.0",
      latestVersion: "1.2.0",
      command: "npm install -g @datalabrotterdam/nova-ai-cli@latest",
    },
  });
  const status = new StatusView(store, "test-model", {
    configured: 0,
    connected: 0,
    failed: 0,
  });
  status.update(store.getState(), "test-model", {
    configured: 0,
    connected: 0,
    failed: 0,
  });

  const lines = status.render(200);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /Update 1\.2\.0 available \(current 1\.1\.0\)/);
  assert.match(
    lines[0]!,
    /npm install -g @datalabrotterdam\/nova-ai-cli@latest/,
  );
});

test("read and search tools stay compact in the transcript", () => {
  const store = createStore(state());
  store.setState({
    messages: [
      {
        id: "tool-list",
        role: "tool",
        call: {
          toolCallId: "call-list",
          name: "list_directory",
          kind: "search",
          mutating: false,
          args: { path: "src" },
          status: "completed",
          output: "a.ts\nb.ts",
          diff: null,
        },
      },
      ...["a.ts", "b.ts"].map((path, index) => ({
        id: `tool-${index}`,
        role: "tool" as const,
        call: {
          toolCallId: `call-${index}`,
          name: "read_file",
          kind: "read",
          mutating: false,
          args: { path: `src/${path}` },
          status: "completed" as const,
          output: "one\ntwo\nthree\n" + "x".repeat(100),
          diff: null,
        },
      })),
    ],
  });
  const transcript = new TranscriptView(store);
  transcript.sync();
  const collapsed = transcript.render(60);
  assert.ok(
    collapsed.some((line) => line.includes("Read 2 files, listed 1 directory")),
  );
  assert.ok(collapsed.some((line) => line.includes("src/a.ts")));
  assert.ok(collapsed.some((line) => line.includes("src/b.ts")));
  assert.equal(
    collapsed.some((line) => line.includes("Output:")),
    false,
  );

  transcript.toggleToolDetails();
  const expanded = transcript.render(60);
  assert.ok(expanded.some((line) => line.includes("src/a.ts")));
  assert.ok(expanded.some((line) => line.includes("src/b.ts")));
  assert.equal(
    expanded.some((line) => line.includes("Read 2 files")),
    false,
  );
  assert.equal(
    expanded.some((line) => line.includes("Output:")),
    false,
  );
  assert.ok(expanded.every((line) => visibleWidth(line) <= 60));
});

test("activity block aggregates reads and shells with a rolling three-row preview", () => {
  const store = createStore(state());
  store.setState({
    messages: [
      {
        id: "read-1",
        role: "tool",
        call: {
          toolCallId: "read-call",
          name: "read_file",
          kind: "read",
          mutating: false,
          args: { path: "src/old.ts" },
          status: "completed",
          output: "ignored file contents",
          diff: null,
        },
      },
      ...["one", "two"].map((name, index) => ({
        id: `shell-${name}`,
        role: "tool" as const,
        call: {
          toolCallId: `shell-call-${name}`,
          name: "run_command",
          kind: "execute",
          mutating: true,
          args: { command: `command-${name}` },
          status: "pending" as const,
          output:
            index === 0
              ? "old output\nfirst visible"
              : "second visible\nthird visible",
          diff: null,
        },
      })),
    ],
  });
  const transcript = new TranscriptView(store);
  transcript.sync();

  const rendered = transcript.render(80);
  assert.equal(rendered.length, 6);
  assert.ok(
    rendered.some((line) =>
      line.includes("Reading 1 file, running 2 shell commands"),
    ),
  );
  assert.ok(rendered.some((line) => line.includes("first visible")));
  assert.ok(rendered.some((line) => line.includes("second visible")));
  assert.ok(rendered.some((line) => line.includes("third visible")));
  const firstDetail = rendered.find((line) => line.includes("first visible"));
  assert.match(firstDetail?.replace(/\u001b\[[0-9;]*m/g, "") ?? "", /^   ⎿  /);
  assert.equal(
    rendered.some(
      (line) => line.includes("src/old.ts") || line.includes("old output"),
    ),
    false,
  );
});

test("failed tools show their reason while activity details are collapsed", () => {
  const store = createStore(state());
  store.setState({
    messages: [
      {
        id: "failed-read",
        role: "tool",
        call: {
          toolCallId: "failed-read-call",
          name: "read_file",
          kind: "read",
          mutating: false,
          args: { path: "src/missing.ts" },
          status: "failed",
          output: "ENOENT: file does not exist",
          diff: null,
        },
      },
    ],
  });
  const transcript = new TranscriptView(store);
  transcript.sync();

  const collapsed = transcript.render(80).join("\n");
  assert.match(collapsed, /Error: ENOENT: file does not exist/);

  transcript.toggleToolDetails();
  assert.match(transcript.render(80).join("\n"), /ENOENT: file does not exist/);
});

test("file edits render only added and removed lines", () => {
  const store = createStore(state());
  store.setState({
    messages: [
      {
        id: "tool-edit",
        role: "tool",
        call: {
          toolCallId: "call-edit",
          name: "edit_file",
          kind: "edit",
          mutating: true,
          args: { path: "src/example.ts" },
          status: "completed",
          output: "Updated src/example.ts.",
          diff: {
            path: "src/example.ts",
            oldText: "unchanged before\nold value\nunchanged after\n",
            newText: "unchanged before\nnew value\nunchanged after\n",
          },
        },
      },
    ],
  });
  const transcript = new TranscriptView(store);
  transcript.sync();

  const rendered = transcript.render(80).join("\n");
  assert.match(rendered, /- old value/);
  assert.match(rendered, /\+ new value/);
  assert.doesNotMatch(
    rendered,
    /unchanged before|unchanged after|Updated src\/example\.ts/,
  );
});

test("scroll panel keeps a bounded viewport and responds to navigation", () => {
  let renders = 0;
  let closed = false;
  const panel = new ScrollPanel(
    "Output",
    Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
    () => 7,
    () => renders++,
    () => (closed = true),
  );

  const first = panel.render(20).join("\n");
  assert.match(first, /line 1/);
  assert.doesNotMatch(first, /line 20/);

  panel.handleInput("\u001b[6~"); // PageDown
  const next = panel.render(20).join("\n");
  assert.doesNotMatch(next, /line 1(?:\D|$)/);
  assert.ok(renders > 0);

  panel.handleInput("\u001b");
  assert.equal(closed, true);
  assert.equal(Key.pageDown, "pageDown");
});

test("bordered tool windows keep a complete border and forward input", () => {
  let input = "";
  const window = new BorderedWindow({
    render: () => ["tool details"],
    handleInput: (data) => {
      input = data;
    },
    invalidate: () => {},
  });

  const lines = window.render(20);
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /┌─+┐/);
  assert.match(lines[1]!, /^│.*│$/);
  assert.match(lines[2]!, /└─+┘/);
  assert.ok(lines.every((line) => visibleWidth(line) === 20));

  window.handleInput("down");
  assert.equal(input, "down");
});

test("bordered popovers preserve both edges when content exceeds the terminal", () => {
  const window = new BorderedWindow(
    {
      render: () => ["title", "one", "two", "three", "controls"],
      invalidate: () => {},
    },
    () => 5,
  );

  const lines = window.render(16);
  assert.equal(lines.length, 5);
  assert.match(lines[0]!, /┌─+┐/);
  assert.ok(lines.some((line) => line.includes("title")));
  assert.ok(lines.some((line) => line.includes("controls")));
  assert.match(lines.at(-1)!, /└─+┘/);
  assert.ok(lines.every((line) => visibleWidth(line) === 16));
});

test("fullscreen layout fills every terminal row and keeps the footer at the bottom", () => {
  const store = createStore(state());
  store.setState({
    messages: Array.from({ length: 12 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant" as const,
      text: `message ${index + 1}`,
      streaming: false,
    })),
  });
  const transcript = new TranscriptView(store);
  transcript.sync();
  let rows = 10;
  let renders = 0;
  const layout = new FullscreenLayout(
    transcript,
    new Text("status", 0, 0),
    new Text("editor", 0, 0),
    () => rows,
    () => renders++,
  );

  const initial = layout.render(40);
  assert.equal(initial.length, 10);
  assert.equal(initial.at(-2), "editor".padEnd(40));
  assert.equal(initial.at(-1), "status".padEnd(40));
  assert.ok(initial.some((line) => line.includes("message 12")));

  layout.scrollOlder(6);
  const older = layout.render(40);
  assert.ok(older.some((line) => line.includes("message 1")));
  assert.equal(
    older.some((line) => line.includes("message 12")),
    false,
  );
  assert.ok(renders > 0);

  rows = 18;
  const resized = layout.render(64);
  assert.equal(resized.length, 18);
  assert.equal(resized.at(-2), "editor".padEnd(64));
  assert.equal(resized.at(-1), "status".padEnd(64));
  assert.ok(resized.every((line) => visibleWidth(line) <= 64));
});

test("fullscreen layout keeps the active question sticky while its answer scrolls", () => {
  const store = createStore(state());
  store.setState({
    messages: [
      { id: "question", role: "user", text: "What changed?" },
      {
        id: "answer",
        role: "assistant",
        text: Array.from(
          { length: 20 },
          (_, index) => `answer line ${index + 1}`,
        ).join("\n\n"),
        streaming: false,
      },
    ],
  });
  const transcript = new TranscriptView(store);
  transcript.sync();
  const layout = new FullscreenLayout(
    transcript,
    new Text("status", 0, 0),
    new Text("editor", 0, 0),
    () => 10,
    () => {},
  );

  const atBottom = layout.render(60);
  assert.match(atBottom[0]!, /What changed\?/);
  assert.ok(atBottom.some((line) => line.includes("answer line 20")));

  layout.scrollOlder(5);
  const scrolled = layout.render(60);
  assert.match(scrolled[0]!, /What changed\?/);
  assert.ok(scrolled.some((line) => line.includes("answer line")));
});

test("fullscreen layout scrolls within a long user message", () => {
  const store = createStore(state());
  store.setState({
    messages: [
      {
        id: "long-question",
        role: "user",
        text: Array.from(
          { length: 50 },
          (_, index) => `question line ${index + 1}`,
        ).join("\n"),
      },
      {
        id: "interrupted-answer",
        role: "assistant",
        text: "The response was interrupted.",
        streaming: false,
      },
      { id: "continue", role: "user", text: "continue" },
    ],
  });
  const transcript = new TranscriptView(store);
  transcript.sync();
  const layout = new FullscreenLayout(
    transcript,
    new Text("status", 0, 0),
    new Text("editor", 0, 0),
    () => 10,
    () => {},
  );

  const atBottom = layout.render(60).join("\n");
  layout.scrollOlder(4);
  const older = layout.render(60).join("\n");

  assert.notEqual(older, atBottom);
  assert.match(atBottom, /question line 4[5-9]|question line 50/);
  assert.match(older, /question line 4[0-9]/);
});

test("selection dialog overwrites a stable rectangle while scrolling", () => {
  let renders = 0;
  const identity = (text: string) => text;
  const dialog = new SelectionDialog(
    "Sessions",
    Array.from({ length: 20 }, (_, index) => ({
      value: `session-${index + 1}`,
      label: `item-${String(index + 1).padStart(2, "0")}`,
      description:
        index % 2 === 0
          ? `updated ${index + 1} with a longer description`
          : `updated ${index + 1}`,
    })),
    {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
    () => 5,
    () => renders++,
    () => {},
    () => {},
  );

  const initial = dialog.render(48);
  assert.equal(initial.length, 9);
  assert.ok(initial.every((line) => visibleWidth(line) === 48));
  assert.ok(initial.some((line) => line.includes("item-01")));

  dialog.handleInput("\u001b[6~"); // PageDown
  const paged = dialog.render(48);
  assert.equal(paged.length, initial.length);
  assert.ok(paged.every((line) => visibleWidth(line) === 48));
  assert.equal(
    paged.some((line) => line.includes("item-01")),
    false,
  );
  assert.ok(paged.at(-1)?.includes("6/20"));

  dialog.handleInput("\u001b[<65;1;1M"); // Wheel down
  const wheeled = dialog.render(48);
  assert.equal(wheeled.length, initial.length);
  assert.ok(wheeled.at(-1)?.includes("9/20"));
  assert.ok(renders >= 2);
});

test("large session picker owns the full viewport without clipping its header", () => {
  const identity = (text: string) => text;
  const dialog = new SelectionDialog(
    "Sessions",
    Array.from({ length: 104 }, (_, index) => ({
      value: String(index + 1),
      label: `session-${index + 1}`,
      description: `2026-06-28T19:${String(index % 60).padStart(2, "0")}:00.000Z`,
    })),
    {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
    () => 29,
    () => {},
    () => {},
    () => {},
  );

  dialog.handleInput("\u001b[F"); // End
  const atEnd = dialog.render(200);
  assert.equal(atEnd.length, 33);
  assert.ok(atEnd[0]?.startsWith("Sessions"));
  assert.ok(atEnd.at(-1)?.startsWith("104/104"));
  assert.equal(atEnd.filter((line) => line.startsWith("> ")).length, 1);
  assert.ok(atEnd.every((line) => visibleWidth(line) === 200));

  dialog.handleInput("\u001b[5~"); // PageUp
  const scrolled = dialog.render(200);
  assert.equal(scrolled.length, 33);
  assert.ok(scrolled[0]?.startsWith("Sessions"));
  assert.equal(scrolled.filter((line) => line.startsWith("> ")).length, 1);
  assert.ok(scrolled.every((line) => visibleWidth(line) === 200));
});

test("session rows render age, one-line prompt, and exact datetime as three columns", () => {
  const identity = (text: string) => text;
  const dialog = new SelectionDialog(
    "Sessions · age | prompt | datetime",
    [
      {
        value: "session-1",
        label: "6w ago",
        description: "Investigate rendering then fix it",
        columns: {
          leading: "6w ago",
          main: "Investigate rendering\nthen fix it",
          trailing: "2026-06-05T10:30:00.000Z",
        },
      },
    ],
    {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
    () => 1,
    () => {},
    () => {},
    () => {},
  );

  const rendered = dialog.render(100);
  const row = rendered[3] ?? "";
  assert.match(
    row,
    /^> 6w ago\s+Investigate rendering then fix it\s+2026-06-05T10:30:00\.000Z/,
  );
  assert.equal(rendered.length, 5);
  assert.ok(rendered.every((line) => visibleWidth(line) === 100));
});
