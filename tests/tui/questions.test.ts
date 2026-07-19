import assert from "node:assert/strict";
import test from "node:test";
import type {
  UserInputRequest,
  UserInputResponse,
} from "../../src/core/user-questions.js";
import {
  OTHER_OPTION_ID,
  toElicitationRequest,
} from "../../src/acp/user-questions.js";
import { QuestionDialog } from "../../src/tui/pi-app/components.js";
import { TuiAcpClient } from "../../src/tui/session/tui-acp-client.js";
import { createStore } from "../../src/tui/state/store.js";
import type {
  QuestionRequestView,
  UIState,
} from "../../src/tui/state/types.js";

const questions: UserInputRequest = {
  message: "A few choices are needed before continuing.",
  questions: [
    {
      id: "framework",
      question: "Which framework?",
      description: "This controls the component architecture.",
      type: "single",
      options: [
        {
          id: "svelte",
          label: "Svelte",
          description: "Keep the existing direction.",
          recommended: true,
        },
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

test("question dialog supports single, multiple, recommendations, descriptions, and Other", () => {
  let result: UserInputResponse | null = null;
  let closed = 0;
  const pending: QuestionRequestView = {
    id: "question-1",
    request: questions,
    resolve: (response) => {
      result = response;
    },
  };
  const dialog = new QuestionDialog(
    pending,
    () => {},
    () => closed++,
  );

  const initial = dialog.render(80).join("\n");
  assert.match(initial, /This controls the component architecture/);
  assert.match(initial, /Svelte.*recommended/);
  assert.match(initial, /Other.*write your own answer/);

  dialog.handleInput("\r"); // choose Svelte for the single-select question
  dialog.handleInput(" "); // check Markdown in the multi-select question
  dialog.handleInput("\u001b[F"); // move to Other
  dialog.handleInput("\r");
  assert.match(dialog.render(80).join("\n"), /Your answer/);
  dialog.handleInput("Vim key bindings");
  dialog.handleInput("\r");

  assert.deepEqual(result, {
    action: "accept",
    answers: [
      {
        questionId: "framework",
        selectedOptionIds: ["svelte"],
        customAnswer: undefined,
      },
      {
        questionId: "features",
        selectedOptionIds: ["markdown", OTHER_OPTION_ID],
        customAnswer: "Vim key bindings",
      },
    ],
  });
  assert.equal(closed, 1);
});

test("TUI ACP client resolves standard form elicitation through pending question state", async () => {
  const store = createStore(state());
  const client = new TuiAcpClient(store, process.cwd());
  const responsePromise = client.createElicitation(
    toElicitationRequest(questions, "test-session", "tool-call-1"),
  );
  const pending = store.getState().pendingQuestion;
  assert.ok(pending);
  pending.resolve({
    action: "accept",
    answers: [
      { questionId: "framework", selectedOptionIds: ["svelte"] },
      { questionId: "features", selectedOptionIds: ["diffs"] },
    ],
  });

  const response = await responsePromise;
  assert.equal(response.action, "accept");
  if (response.action !== "accept") throw new Error("Expected acceptance.");
  assert.equal(response.content?.framework, "svelte");
  assert.deepEqual(response.content?.features, ["diffs"]);
  assert.equal(store.getState().pendingQuestion, null);
});

function state(): UIState {
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
    cwd: process.cwd(),
    statusLine: null,
    queuedCount: 0,
    contextUsage: null,
    updateAvailable: null,
  };
}
