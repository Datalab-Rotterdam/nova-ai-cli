import assert from "node:assert/strict";
import test from "node:test";
import { Text, TUI, type Terminal } from "@earendil-works/pi-tui";
import {
  FullscreenLayout,
  SelectionDialog,
  TranscriptView,
} from "../../src/tui/pi-app/components.js";
import { PromptEditor } from "../../src/tui/pi-app/prompt-editor.js";
import { editorTheme } from "../../src/tui/pi-app/theme.js";
import { createStore } from "../../src/tui/state/store.js";
import type { UIState } from "../../src/tui/state/types.js";

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
  };
}

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
