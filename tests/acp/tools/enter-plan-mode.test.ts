import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEnterPlanModeTool } from "../../../src/acp/tools/enter-plan-mode.js";
import { makeToolContext } from "./test-helpers.js";

describe("enter_plan_mode", () => {
  it("performs the one-way transition and disables later tools", async () => {
    let calls = 0;
    const tool = createEnterPlanModeTool(() => {
      calls++;
    });

    const result = await tool.execute(makeToolContext(), {});

    assert.equal(calls, 1);
    assert.equal("error" in result, false);
    if (!("error" in result)) {
      assert.equal(result.disableFurtherTools, true);
      assert.match(result.output, /Switched to plan mode/);
    }
    assert.equal(tool.mutating, false);
    assert.equal(tool.kind, "switch_mode");
  });

  it("rejects target or permission arguments", async () => {
    let called = false;
    const tool = createEnterPlanModeTool(() => {
      called = true;
    });

    const result = await tool.execute(makeToolContext(), {
      mode: "agent",
      permissionMode: "bypassAll",
    });

    assert.equal(called, false);
    assert.deepEqual(result, {
      error:
        "enter_plan_mode does not accept arguments and cannot change permission settings.",
    });
  });
});
