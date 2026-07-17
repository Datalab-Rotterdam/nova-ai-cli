import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UserInputRequest } from "../../../src/core/user-questions.js";
import { askUserTool } from "../../../src/acp/tools/ask-user.js";
import { makeToolContext } from "./test-helpers.js";

describe("askUserTool", () => {
  it("passes descriptions, recommendations, cardinality, and custom answers to the host", async () => {
    let captured!: UserInputRequest;
    const context = makeToolContext({
      host: {
        requestUserInput: async (request) => {
          captured = request;
          return {
            action: "accept",
            answers: [
              {
                questionId: "framework",
                selectedOptionIds: ["svelte"],
              },
              {
                questionId: "features",
                selectedOptionIds: ["markdown", "__other__"],
                customAnswer: "Vim key bindings",
              },
            ],
          };
        },
      },
    });

    const result = await askUserTool.execute(context, {
      message: "Choose the TUI direction.",
      questions: [
        {
          id: "framework",
          question: "Which framework?",
          description: "This affects the rendering architecture.",
          type: "single",
          options: [
            {
              id: "svelte",
              label: "Svelte",
              description: "Use the current component model.",
              recommended: true,
            },
            { id: "react", label: "React" },
          ],
        },
        {
          id: "features",
          question: "Which features?",
          type: "multiple",
          options: [
            { id: "markdown", label: "Markdown" },
            { id: "diffs", label: "Diffs" },
          ],
        },
      ],
    });

    assert.equal(
      captured?.questions[0]?.description,
      "This affects the rendering architecture.",
    );
    assert.equal(captured?.questions[0]?.options[0]?.recommended, true);
    assert.equal(captured?.questions[1]?.type, "multiple");
    assert.deepEqual(result, {
      output:
        "User answers:\n- Which framework?: Svelte\n- Which features?: Markdown, Vim key bindings",
    });
  });

  it("rejects more than one recommended option", async () => {
    const result = await askUserTool.execute(makeToolContext(), {
      questions: [
        {
          id: "choice",
          question: "Choose one",
          options: [
            { id: "one", label: "One", recommended: true },
            { id: "two", label: "Two", recommended: true },
          ],
        },
      ],
    });
    assert.deepEqual(result, {
      error: "Question 'choice' can have only one recommended option.",
    });
  });
});
