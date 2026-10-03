import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { OTHER_OPTION_ID } from "../../src/core/user-questions.js";
import type { UserInputRequest, UserInputResponse } from "../../src/core/user-questions.js";
import {
  permissionKey,
  QuestionState,
  ScrollState,
  SelectionState,
  ToolInspectorState,
} from "../../src/tui/ink/dialogs/state.js";
import {
  PermissionDialog,
  QuestionDialog,
  ScrollPanel,
  SelectionDialog,
  ToolInspector,
} from "../../src/tui/ink/dialogs/views.js";
import type { PermissionScope, ToolCallView } from "../../src/tui/state/types.js";

const plain = (text: string | undefined) => (text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

const questions: UserInputRequest = {
  message: "A few choices are needed before continuing.",
  questions: [
    {
      id: "framework",
      question: "Which framework?",
      description: "This controls the component architecture.",
      type: "single",
      options: [
        { id: "svelte", label: "Svelte", description: "Keep the existing direction.", recommended: true },
        { id: "react", label: "React" },
      ],
    },
    {
      id: "features",
      question: "Which features should be included?",
      type: "multiple",
      options: [
        { id: "markdown", label: "Markdown" },
        { id: "diffs", label: "Diff rendering" },
      ],
    },
  ],
};

test("question dialog supports single, multiple, recommendations, descriptions, and Other", async () => {
  let result: UserInputResponse | null = null;
  let closed = 0;
  const state = new QuestionState(
    { id: "question-1", request: questions, resolve: (response) => (result = response) },
    () => closed++,
  );
  const view = render(createElement(QuestionDialog, { state }));
  await tick();
  const initial = plain(view.lastFrame());
  assert.match(initial, /This controls the component architecture/);
  assert.match(initial, /Svelte.*recommended/);
  assert.match(initial, /Other.*write your own answer/);

  view.stdin.write("\r"); // Svelte for the single-select question
  await tick();
  view.stdin.write(" "); // check Markdown
  await tick();
  view.stdin.write("\u001b[F"); // End: move to Other
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(plain(view.lastFrame()), /Your answer/);
  view.stdin.write("Vim key bindings");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.unmount();

  assert.deepEqual(result, {
    action: "accept",
    answers: [
      { questionId: "framework", selectedOptionIds: ["svelte"], customAnswer: undefined },
      {
        questionId: "features",
        selectedOptionIds: ["markdown", OTHER_OPTION_ID],
        customAnswer: "Vim key bindings",
      },
    ],
  });
  assert.equal(closed, 1);
});

test("a multiple-choice question needs a selection and Esc cancels", () => {
  let result: UserInputResponse | null = null;
  const state = new QuestionState(
    { id: "q", request: { ...questions, questions: [questions.questions[1]!] }, resolve: (r) => (result = r) },
    () => {},
  );
  assert.equal(state.handleKey("\r", { return: true }), "changed");
  assert.match(state.validationMessage, /Select at least one option/);
  assert.equal(state.handleKey("", { escape: true }), "closed");
  assert.deepEqual(result, { action: "cancel", answers: [] });
});

test("selection navigates with wrap and pages, selects on Enter and cancels on Esc", () => {
  const selected: string[] = [];
  let cancelled = 0;
  const items = Array.from({ length: 10 }, (_, index) => ({ value: `v${index}`, label: `item ${index}` }));
  const state = new SelectionState(items, (item) => selected.push(item.value), () => cancelled++);
  state.handleKey("", { upArrow: true }, 4);
  assert.equal(state.selected, 9, "Up on the first item wraps to the last");
  state.handleKey("", { downArrow: true }, 4);
  assert.equal(state.selected, 0);
  state.handleKey("", { pageDown: true }, 4);
  assert.equal(state.selected, 4);
  state.handleKey("", { end: true }, 4);
  state.handleKey("\r", { return: true }, 4);
  assert.deepEqual(selected, ["v9"]);
  state.handleKey("c", { ctrl: true }, 4);
  assert.equal(cancelled, 1);
});

test("session rows render age, one-line prompt, and exact datetime as three columns", async () => {
  const state = new SelectionState(
    [
      {
        value: "session-1",
        label: "6w ago",
        description: "Investigate rendering then fix it",
        columns: { leading: "6w ago", main: "Investigate rendering\nthen fix it", trailing: "2026-06-05T10:30:00.000Z" },
      },
    ],
    () => {},
    () => {},
  );
  const view = render(createElement(SelectionDialog, { title: "Sessions · age | prompt | datetime", state, height: 20 }));
  await tick();
  const frame = plain(view.lastFrame());
  view.unmount();
  assert.match(frame, /Sessions · age \| prompt \| datetime/);
  assert.match(frame, /> 6w ago\s+Investigate rendering then fix it\s+2026-06-05T10:30:00\.000Z/);
});

test("a long selection list shows a window around the selection", async () => {
  const items = Array.from({ length: 60 }, (_, index) => ({ value: `v${index}`, label: `item ${String(index).padStart(2, "0")}` }));
  const state = new SelectionState(items, () => {}, () => {});
  const view = render(createElement(SelectionDialog, { title: "Models", state, height: 12 }));
  await tick();
  view.stdin.write("\u001b[6~"); // Page Down
  await tick();
  const frame = plain(view.lastFrame());
  view.unmount();
  assert.equal(frame.split("\n").filter((line) => /item \d\d/.test(line)).length, 7);
  assert.match(frame, /> item 07/);
  assert.match(frame, /8\/60/);
});

test("scroll panel keeps a bounded viewport and responds to navigation", async () => {
  const content = Array.from({ length: 40 }, (_, index) => `row ${index + 1}`).join("\n");
  let closed = 0;
  const state = new ScrollState(() => closed++);
  const view = render(createElement(ScrollPanel, { title: "Output", content, state, height: 10, width: 60 }));
  await tick();
  assert.match(plain(view.lastFrame()), /1-6 of 40/);
  view.stdin.write("\u001b[6~");
  await tick();
  assert.match(plain(view.lastFrame()), /7-12 of 40/);
  view.stdin.write("\u001b[F");
  await tick();
  const end = plain(view.lastFrame());
  assert.match(end, /35-40 of 40/);
  assert.match(end, /row 40/);
  view.stdin.write("\u001b");
  await tick();
  view.unmount();
  assert.equal(closed, 1);
});

test("tool inspector selects calls and expands details in place", async () => {
  const calls: ToolCallView[] = ["a", "b"].map((name) => ({
    toolCallId: `call-${name}`,
    name: "read_file",
    kind: "read",
    mutating: false,
    args: { path: `src/${name}.ts` },
    status: "completed",
    output: `contents of ${name}`,
    diff: null,
  }));
  const state = new ToolInspectorState(() => calls, () => {});
  const view = render(createElement(ToolInspector, { state, height: 20, width: 80 }));
  await tick();
  assert.match(plain(view.lastFrame()), /Tool calls \(2\)/);
  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\r");
  await tick();
  const expanded = plain(view.lastFrame());
  view.unmount();
  assert.match(expanded, /v ✓ read_file: src\/b\.ts/);
  assert.match(expanded, /Arguments:/);
  assert.match(expanded, /contents of b/);
  assert.doesNotMatch(expanded, /contents of a/);
});

test("permission dialog answers with a, s, w, d and Esc", async () => {
  const answers: Array<[boolean, PermissionScope]> = [];
  const request = {
    toolCallId: "t1",
    toolName: "run_command",
    title: "Run `npm test`",
    kind: "execute",
    args: { command: "npm test" },
    resolve: (allow: boolean, scope: PermissionScope) => answers.push([allow, scope]),
  };
  const view = render(createElement(PermissionDialog, { request, onClose: () => {} }));
  await tick();
  const frame = plain(view.lastFrame());
  view.unmount();
  assert.match(frame, /Run `npm test`/);
  assert.match(frame, /\[a\] once {2}\[s\] this session {2}\[w\] always {2}\[d\] deny/);

  for (const input of ["a", "s", "w", "d"]) permissionKey(request, input, {});
  permissionKey(request, "", { escape: true });
  assert.equal(permissionKey(request, "x", {}), "ignored");
  assert.deepEqual(answers, [
    [true, "once"],
    [true, "session"],
    [true, "always"],
    [false, "once"],
    [false, "once"],
  ]);
});
