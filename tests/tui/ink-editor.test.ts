import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DraftImageAttachments } from "../../src/tui/files/prompt-images.js";
import { WorkspaceAutocompleteProvider } from "../../src/tui/files/workspace-autocomplete.js";
import { TextBuffer } from "../../src/tui/ink/editor/buffer.js";
import { PromptEditor, type KeyPress } from "../../src/tui/ink/editor/prompt-editor.js";
import { bindPromptSubmission } from "../../src/tui/ink/prompt-submission.js";
import { SessionRunner } from "../../src/tui/session/session-runner.js";
import { createStore } from "../../src/tui/state/store.js";
import type { UIState } from "../../src/tui/state/types.js";
import { installFakeAgentQueue } from "./fake-agent-queue.js";

const ENTER: KeyPress = { return: true };
const UP: KeyPress = { upArrow: true };
const DOWN: KeyPress = { downArrow: true };

function type(editor: PromptEditor, text: string): void {
  for (const character of text) editor.handleKey(character, {});
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("text buffer edits by grapheme and moves across lines", () => {
  const buffer = new TextBuffer();
  buffer.insert("a👍🏽b");
  buffer.left();
  buffer.backspace();
  assert.equal(buffer.text, "ab", "the skin-tone emoji is deleted as one unit");

  buffer.setText("first line\nsecond");
  assert.deepEqual(buffer.cursor, { row: 1, col: 6 });
  assert.equal(buffer.up(), true);
  assert.deepEqual(buffer.cursor, { row: 0, col: 6 });
  assert.equal(buffer.up(), false, "no line above the first");
  buffer.lineEnd();
  buffer.deleteForward();
  assert.equal(buffer.text, "first linesecond", "delete at line end joins lines");

  buffer.setText("npm run build -- --watch");
  buffer.deleteWordBackward();
  assert.equal(buffer.text, "npm run build -- --");
  buffer.wordLeft();
  assert.equal(buffer.cursor.col, "npm run ".length, "punctuation is skipped with the word");
  buffer.deleteToLineStart();
  assert.equal(buffer.text, "build -- --");
});

test("prompt editor submits on Enter and inserts new lines with Alt+Enter, Ctrl+J and a trailing backslash", () => {
  const editor = new PromptEditor();
  const submitted: string[] = [];
  editor.onSubmit = (text) => submitted.push(text);

  type(editor, "one");
  editor.handleKey("\r", { return: true, meta: true });
  type(editor, "two");
  editor.handleKey("\n", {});
  type(editor, "three\\");
  editor.handleKey("\r", ENTER);
  type(editor, "four");
  assert.equal(editor.getText(), "one\ntwo\nthree\nfour");
  assert.deepEqual(submitted, []);

  editor.handleKey("\r", ENTER);
  assert.deepEqual(submitted, ["one\ntwo\nthree\nfour"]);
  assert.equal(editor.getText(), "");
});

test("a typed chunk that contains carriage returns submits each line", () => {
  const editor = new PromptEditor();
  const submitted: string[] = [];
  editor.onSubmit = (text) => submitted.push(text);
  editor.handleKey("first\rsecond\r", {});
  assert.deepEqual(submitted, ["first", "second"]);
});

test("prompt editor leaves global shortcuts to the app", () => {
  const editor = new PromptEditor();
  assert.equal(editor.handleKey("r", { ctrl: true }), false);
  assert.equal(editor.handleKey("", { escape: true }), false);
  assert.equal(editor.handleKey("", { tab: true, shift: true }), false);
  assert.equal(editor.handleKey("v", { meta: true }), false);
  assert.equal(editor.getText(), "");
});

test("prompt editor recalls earlier prompts with Up/Down and keeps the draft", () => {
  const editor = new PromptEditor();
  editor.addToHistory("older prompt");
  editor.addToHistory("newer prompt");
  type(editor, "draft");

  editor.handleKey("", UP);
  assert.equal(editor.getText(), "newer prompt");
  editor.handleKey("", UP);
  assert.equal(editor.getText(), "older prompt");
  editor.handleKey("", UP);
  assert.equal(editor.getText(), "older prompt");
  editor.handleKey("", DOWN);
  assert.equal(editor.getText(), "newer prompt");
  editor.handleKey("", DOWN);
  assert.equal(editor.getText(), "draft");
});

test("prompt editor recalls, edits, and removes queued messages with Up/Down", () => {
  const editor = new PromptEditor();
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
    queued = queued.map((item) => (item.id === activeId ? { ...item, text } : item));
  };

  editor.handleKey("", UP);
  assert.equal(editor.getText(), "second queued message");
  editor.handleKey("", UP);
  assert.equal(editor.getText(), "first queued message");
  editor.handleKey("", DOWN);
  assert.equal(editor.getText(), "second queued message");

  editor.handleKey("!", {});
  assert.equal(queued[1]?.text, "second queued message!");
  editor.setText("");
  editor.handleKey("\r", ENTER);
  assert.deepEqual(queued, [{ id: "older", text: "first queued message" }]);
  assert.equal(editor.editingQueuedMessage(), null);
  assert.equal(editor.getText(), "");
});

test("prompt editor collapses a large paste into a readable marker", () => {
  const editor = new PromptEditor();
  const pastedText = Array.from({ length: 12 }, (_, index) => `clipboard line ${index + 1}`).join("\n");

  editor.paste(pastedText);
  const marker = "[Pasted from clipboard #1: 12 lines]";
  assert.equal(editor.getText(), marker);
  assert.deepEqual(editor.referencedPastes(editor.getText()), [
    { marker, text: pastedText, lineCount: 12, characterCount: pastedText.length },
  ]);

  let submitted = "";
  editor.onSubmit = (text) => {
    submitted = text;
  };
  editor.handleKey("\r", ENTER);
  assert.equal(submitted, marker);
});

test("prompt editor keeps ordinary pastes inline and counts characters of long single lines", () => {
  const editor = new PromptEditor();
  editor.paste("first\r\nsecond");
  assert.equal(editor.getText(), "first\nsecond");
  assert.deepEqual(editor.referencedPastes(editor.getText()), []);

  const long = new PromptEditor();
  long.paste("x".repeat(1_001));
  assert.equal(long.getText(), "[Pasted from clipboard #1: 1001 characters]");
  assert.equal(long.referencedPastes(long.getText())[0]?.text, "x".repeat(1_001));
});

test("slash-command autocomplete completes with Tab and runs an exact command on Enter", async () => {
  const editor = new PromptEditor();
  editor.setAutocompleteProvider(
    new WorkspaceAutocompleteProvider(
      [
        { name: "help", description: "Show help" },
        { name: "history", description: "Show history" },
      ],
      process.cwd(),
      [],
    ),
  );
  const submitted: string[] = [];
  editor.onSubmit = (text) => submitted.push(text);

  type(editor, "/he");
  await tick();
  assert.deepEqual(editor.autocomplete?.items.map((item) => item.value), ["help"]);
  editor.handleKey("", { tab: true });
  assert.equal(editor.getText(), "/help ");
  assert.equal(editor.autocomplete, null);

  editor.setText("");
  type(editor, "/help");
  await tick();
  assert.ok(editor.autocomplete);
  editor.handleKey("\r", ENTER);
  assert.deepEqual(submitted, ["/help"]);
});

test("@file autocomplete lists matches, Esc closes it, and Tab completes paths", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-autocomplete-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "main.ts"), "");
  writeFileSync(join(cwd, "README.md"), "");
  const editor = new PromptEditor();
  editor.setAutocompleteProvider(
    new WorkspaceAutocompleteProvider([], cwd, ["src/main.ts", "README.md"]),
  );

  type(editor, "look at @mai");
  await tick();
  assert.equal(editor.autocomplete?.items[0]?.value, "@src/main.ts");
  editor.handleKey("", { escape: true });
  assert.equal(editor.autocomplete, null);
  type(editor, "n");
  await tick();
  editor.handleKey("", { tab: true });
  assert.equal(editor.getText(), "look at @src/main.ts ");

  editor.setText("cat sr");
  editor.handleKey("", { tab: true });
  for (let attempt = 0; attempt < 5 && editor.getText() === "cat sr"; attempt++) await tick();
  assert.equal(editor.getText(), "cat src/", "a single match completes right away");
});

test("live prompt submission stays unlocked so follow-ups are queued", async () => {
  const editor = new PromptEditor();
  const store = createStore(initialState());
  const runner = new SessionRunner(store, { apiKey: "test", defaultModel: "test-model" }, process.cwd());
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
      prompt(params: { prompt: Array<{ type: string; text: string }> }): Promise<{ stopReason: "end_turn" }>;
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
  editor.handleKey("\r", ENTER);
  await firstStarted;

  editor.setText("queued follow-up");
  editor.handleKey("\r", ENTER);

  assert.equal(store.getState().queuedCount, 1);
  assert.deepEqual(runner.queuedMessages(), ["queued follow-up"]);

  releaseFirst();
  for (let attempt = 0; attempt < 5 && prompts.length < 2; attempt++) await tick();
  assert.deepEqual(prompts, ["initial request", "queued follow-up"]);
  assert.deepEqual(errors, []);
  await runner.close();
});

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
    cwd: process.cwd(),
    statusLine: null,
    queuedCount: 0,
    contextUsage: null,
    updateAvailable: null,
  };
}
