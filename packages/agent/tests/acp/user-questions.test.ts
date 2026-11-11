import assert from "node:assert/strict";
import test from "node:test";
import type { UserInputRequest } from "../../src/core/user-questions.js";
import {
  OTHER_OPTION_ID,
  fromElicitationRequest,
  fromElicitationResponse,
  toElicitationRequest,
  toElicitationResponse,
} from "../../src/acp/user-questions.js";

const request: UserInputRequest = {
  message: "Choose what to build.",
  questions: [
    {
      id: "framework",
      question: "Which framework?",
      description: "Pick the primary UI framework.",
      type: "single",
      options: [
        {
          id: "svelte",
          label: "Svelte",
          description: "Small and direct.",
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
};

test("questions map to ACP form elicitation with an Other field", () => {
  const elicitation = toElicitationRequest(request, "session-1", "call-1");
  assert.equal(elicitation.mode, "form");
  if (elicitation.mode !== "form") throw new Error("Expected form mode.");
  const framework = elicitation.requestedSchema.properties?.framework;
  const features = elicitation.requestedSchema.properties?.features;
  assert.equal(framework?.type, "string");
  assert.equal(features?.type, "array");
  if (framework?.type !== "string" || features?.type !== "array")
    throw new Error("Expected single and multiple properties.");
  assert.equal(framework.oneOf?.at(-1)?.const, OTHER_OPTION_ID);
  assert.match(framework.oneOf?.[0]?.title ?? "", /Recommended/);
  assert.ok(elicitation.requestedSchema.properties?.framework__other_text);
  assert.deepEqual(fromElicitationRequest(elicitation), request);
});

test("ACP answers preserve single, multiple, and custom values", () => {
  const response = toElicitationResponse(request, {
    action: "accept",
    answers: [
      { questionId: "framework", selectedOptionIds: ["svelte"] },
      {
        questionId: "features",
        selectedOptionIds: ["markdown", OTHER_OPTION_ID],
        customAnswer: "Mouse support",
      },
    ],
  });
  assert.equal(response.action, "accept");
  if (response.action !== "accept") throw new Error("Expected acceptance.");
  assert.equal(response.content?.framework, "svelte");
  assert.deepEqual(response.content?.features, ["markdown", OTHER_OPTION_ID]);
  assert.equal(response.content?.features__other_text, "Mouse support");
  assert.deepEqual(fromElicitationResponse(request, response), {
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
        customAnswer: "Mouse support",
      },
    ],
  });
});
