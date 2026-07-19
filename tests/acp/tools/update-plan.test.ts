import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { createUpdatePlanTool } from "../../../src/acp/tools/update-plan.js";
import { buildToolsSystemPrompt } from "../../../src/acp/tools/system-prompt.js";
import { makeToolContext } from "./test-helpers.js";

describe("update_plan", () => {
  it("publishes a complete ordered ACP checklist", async () => {
    let published: acp.PlanEntry[] = [];
    const tool = createUpdatePlanTool((entries) => {
      published = entries;
    });

    const result = await tool.execute(makeToolContext(), {
      plan: [
        { step: "Inspect the request", status: "completed" },
        { step: "Implement the change", status: "in_progress" },
        { step: "Run validation", status: "pending" },
      ],
    });

    assert.deepEqual(published, [
      {
        content: "Inspect the request",
        priority: "medium",
        status: "completed",
      },
      {
        content: "Implement the change",
        priority: "medium",
        status: "in_progress",
      },
      {
        content: "Run validation",
        priority: "medium",
        status: "pending",
      },
    ]);
    assert.equal("error" in result, false);
    if (!("error" in result)) {
      assert.match(result.output, /1\/3 completed, 1 in progress/);
    }
    assert.equal(tool.mutating, false);
    assert.equal(tool.kind, "think");
    assert.match(buildToolsSystemPrompt([tool], "/repo") ?? "", /"step"/);
  });

  it("rejects empty, duplicate, and concurrently active plans", async () => {
    const tool = createUpdatePlanTool(() => {});

    assert.deepEqual(await tool.execute(makeToolContext(), { plan: [] }), {
      error: "update_plan requires at least one checklist item.",
    });
    assert.deepEqual(
      await tool.execute(makeToolContext(), {
        plan: [
          { step: "Same step", status: "pending" },
          { step: "same step", status: "completed" },
        ],
      }),
      { error: "update_plan contains a duplicate step: same step" },
    );
    assert.deepEqual(
      await tool.execute(makeToolContext(), {
        plan: [
          { step: "First", status: "in_progress" },
          { step: "Second", status: "in_progress" },
        ],
      }),
      { error: "update_plan allows at most one in_progress item." },
    );
  });
});
