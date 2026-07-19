import assert from "node:assert/strict";
import test from "node:test";
import { Text, TUI, type Terminal } from "@earendil-works/pi-tui";
import {
  FullscreenLayout,
  SelectionDialog,
  TranscriptView,
} from "../../src/tui/pi-app/components.js";
import { PromptEditor } from "../../src/tui/pi-app/prompt-editor.js";
import { bindPromptSubmission } from "../../src/tui/pi-app/prompt-submission.js";
import { editorTheme } from "../../src/tui/pi-app/theme.js";
import { DraftImageAttachments } from "../../src/tui/files/prompt-images.js";
import { SessionRunner } from "../../src/tui/session/session-runner.js";
import { createStore } from "../../src/tui/state/store.js";
import type { UIState } from "../../src/tui/state/types.js";
import { installFakeAgentQueue } from "./fake-agent-queue.js";

class MemoryTerminal implements Terminal {
  columns = 50;
  rows = 12;
  kittyProtocolActive = false;
  output = "";
  started = false;
  stopped = false;
  cursorShown = false;
  private input?: (data: string) => void;
  private resize?: () => void;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.started = true;
    this.input = onInput;
    this.resize = onResize;
  }
  stop(): void {
    this.stopped = true;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
  }
  moveBy(): void {}
  hideCursor(): void {
    this.cursorShown = false;
  }
  showCursor(): void {
    this.cursorShown = true;
  }
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {
    this.output += "[clear]";
  }
  setTitle(): void {}
  setProgress(): void {}

  setSize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.resize?.();
  }

  sendInput(data: string): void {
    this.input?.(data);
  }
}

function initialState(): UIState {
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
    sessionId: "runtime-test",
    cwd: "C:\\workspace",
    statusLine: null,
    queuedCount: 0,
    contextUsage: null,
    updateAvailable: null,
  };
}

test("prompt editor recalls, edits, and removes queued messages with Up/Down", () => {
  const terminal = new MemoryTerminal();
  const tui = new TUI(terminal, true);
  const editor = new PromptEditor(tui, editorTheme);
  let activeId: string | null = null;
  let queued = [
    { id: "older", text: "first queued message" },
    { id: "newer", text: "second queued message" },
  ];

  editor.setQueuedMessageProvider(() => queued.map((item) => ({ ...item })));
  editor.onQueuedMessageEditStart = (id) => {
    activeId = id;
  };
  editor.onQueuedMessageEditFinish = (id, text) => {
    const value = text.trim();
    queued = value
      ? queued.map((item) => (item.id === id ? { ...item, text: value } : item))
      : queued.filter((item) => item.id !== id);
    activeId = null;
  };
  editor.onChange = (text) => {
    if (!activeId) return;
    queued = queued.map((item) =>
      item.id === activeId ? { ...item, text } : item,
    );
  };

  editor.handleInput("\u001b[A");
  assert.equal(editor.getText(), "second queued message");
  editor.handleInput("\u001b[A");
  assert.equal(editor.getText(), "first queued message");
  editor.handleInput("\u001b[B");
  assert.equal(editor.getText(), "second queued message");

  editor.handleInput("!");
  assert.equal(queued[1]?.text, "second queued message!");
  editor.setText("");
  editor.handleInput("\r");
  assert.deepEqual(queued, [{ id: "older", text: "first queued message" }]);
  assert.equal(editor.editingQueuedMessage(), null);
  assert.equal(editor.getText(), "");
});

test("live prompt submission remains unlocked and renders queued follow-ups", async () => {
  const terminal = new MemoryTerminal();
  const tui = new TUI(terminal, true);
  const editor = new PromptEditor(tui, editorTheme);
  const store = createStore(initialState());
  const runner = new SessionRunner(
    store,
    { apiKey: "test", defaultModel: "test-model" },
    process.cwd(),
  );
  installFakeAgentQueue(runner);
  const prompts: string[] = [];
  const errors: string[] = [];
  let markStarted!: () => void;
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const internals = runner as unknown as {
    ensureSession(): Promise<void>;
    agent: {
      prompt(params: {
        prompt: Array<{ type: string; text: string }>;
      }): Promise<{ stopReason: "end_turn" }>;
    };
  };
  internals.ensureSession = async () => {};
  internals.agent.prompt = async (params) => {
    prompts.push(params.prompt[0]?.text ?? "");
    if (prompts.length === 1) {
      markStarted();
      await firstReleased;
    }
    return { stopReason: "end_turn" };
  };

  bindPromptSubmission({
    editor,
    draftImages: new DraftImageAttachments(),
    runner,
    store,
    submit: (text, images, pastes) => runner.submit(text, images, pastes),
    appendError: (text) => errors.push(text),
  });

  editor.setText("initial request");
  editor.handleInput("\r");
  await firstStarted;

  editor.setText("queued follow-up");
  editor.handleInput("\r");

  assert.equal(store.getState().queuedCount, 1);
  assert.deepEqual(runner.queuedMessages(), ["queued follow-up"]);
  const queued = store
    .getState()
    .messages.find((message) => message.role === "user" && message.queued);
  assert.ok(queued?.role === "user");
  assert.equal(queued.text, "queued follow-up");

  const transcript = new TranscriptView(store);
  transcript.sync();
  const rendered = transcript.render(terminal.columns).join("\n");
  assert.match(rendered, /queued>/);
  assert.match(rendered, /queued follow-up/);

  releaseFirst();
  for (let attempt = 0; attempt < 5 && prompts.length < 2; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(prompts, ["initial request", "queued follow-up"]);
  assert.deepEqual(errors, []);
});

test("prompt editor collapses large clipboard text into a readable marker", () => {
  const terminal = new MemoryTerminal();
  const tui = new TUI(terminal, true);
  const editor = new PromptEditor(tui, editorTheme);
  const pastedText = Array.from(
    { length: 12 },
    (_, index) => `clipboard line ${index + 1}`,
  ).join("\n");

  const midpoint = Math.floor(pastedText.length / 2);
  editor.handleInput(`\u001b[200~${pastedText.slice(0, midpoint)}`);
  assert.equal(editor.getText(), "");
  editor.handleInput(`${pastedText.slice(midpoint)}\u001b[201~`);

  const marker = "[Pasted from clipboard #1: 12 lines]";
  assert.equal(editor.getText(), marker);
  assert.deepEqual(editor.referencedPastes(editor.getText()), [
    {
      marker,
      text: pastedText,
      lineCount: 12,
      characterCount: pastedText.length,
    },
  ]);
  assert.match(editor.render(terminal.columns).join("\n"), /12 lines/);

  let submitted = "";
  editor.onSubmit = (text) => {
    submitted = text;
  };
  editor.handleInput("\r");
  assert.equal(submitted, marker);
});

test("prompt editor leaves ordinary clipboard text inline", () => {
  const terminal = new MemoryTerminal();
  const tui = new TUI(terminal, true);
  const editor = new PromptEditor(tui, editorTheme);

  editor.handleInput("\u001b[200~first\r\nsecond\u001b[201~");

  assert.equal(editor.getText(), "first\nsecond");
  assert.deepEqual(editor.referencedPastes(editor.getText()), []);
});

test("prompt editor reports character count for a long single-line paste", () => {
  const terminal = new MemoryTerminal();
  const tui = new TUI(terminal, true);
  const editor = new PromptEditor(tui, editorTheme);
  const pastedText = "x".repeat(1_001);

  editor.handleInput(`\u001b[200~${pastedText}\u001b[201~`);

  assert.equal(editor.getText(), "[Pasted from clipboard #1: 1001 characters]");
  assert.equal(editor.referencedPastes(editor.getText())[0]?.text, pastedText);
});

test("Pi TUI runtime renders store updates and restores terminal lifecycle", async () => {
  const terminal = new MemoryTerminal();
  const store = createStore(initialState());
  const transcript = new TranscriptView(store);
  const tui = new TUI(terminal, true);
  const editor = new PromptEditor(tui, editorTheme);
  const layout = new FullscreenLayout(
    transcript,
    new Text("status", 0, 0),
    editor,
    () => terminal.rows,
    () => tui.requestRender(),
  );
  tui.addChild(layout);
  tui.setFocus(editor);
  tui.start();
  tui.requestRender(true);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(terminal.started, true);
  assert.match(terminal.output, /Nova AI/);
  assert.match(terminal.output, />/);
  assert.equal(terminal.cursorShown, true);
  assert.equal(layout.render(terminal.columns).length, 12);

  store.setState({
    messages: [
      {
        id: "answer",
        role: "assistant",
        text: "Rendered through the real TUI engine.",
        streaming: false,
      },
    ],
  });
  transcript.sync();
  tui.requestRender();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(terminal.output, /Rendered through the real TUI engine/);

  const redraws = tui.fullRedraws;
  terminal.setSize(72, 20);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(layout.render(terminal.columns).length, 20);
  assert.ok(
    tui.fullRedraws > redraws,
    "resize should force a full viewport redraw",
  );
  assert.match(
    terminal.output,
    /\u001b\[2J\u001b\[H/,
    "resize should clear and repaint from terminal home",
  );

  const identity = (text: string) => text;
  const dialog = new SelectionDialog(
    "Sessions",
    Array.from({ length: 30 }, (_, index) => ({
      value: String(index),
      label: `session-${index + 1}`,
      description: `updated-${index + 1}`,
    })),
    {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
    () => terminal.rows - 4,
    () => tui.requestRender(true),
    () => {},
    () => {},
  );
  layout.showFullscreen(dialog);
  tui.setFocus(dialog);
  tui.requestRender(true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(terminal.output, /Sessions/);
  terminal.output = "";
  terminal.sendInput("\u001b[6~");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(
    terminal.output,
    /\u001b\[2J\u001b\[H/,
    "scrolling a picker should repaint from terminal home",
  );
  assert.match(terminal.output, /session-17/);
  assert.match(terminal.output, /Sessions/);
  layout.hideFullscreen();

  tui.stop();
  assert.equal(terminal.stopped, true);
});
