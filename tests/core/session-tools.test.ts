import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "../../src/core/agent/session.js";
import { buildSessionTools } from "../../src/core/agent/session-tools.js";
import { PromptQueue } from "../../src/core/prompt-queue.js";
import { PermissionPolicy } from "../../src/core/policy/policy.js";
import { FULL_CAPABILITIES, makeEnvironment } from "./tools/test-helpers.js";

function session(): Session {
  return {
    pendingPrompt: null,
    promptQueue: new PromptQueue(),
    cwd: process.cwd(),
    history: [],
    pendingBackgroundHandoffs: [],
    title: null,
    mcpConnections: [],
    mcpTools: [],
    mcpFailures: [],
    environment: makeEnvironment(),
    skills: [],
    memory: { blocks: [], notes: [], consolidate: [] },
    mode: "agent",
    policy: new PermissionPolicy(process.cwd(), "default"),
    model: null,
  };
}

const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);

describe("buildSessionTools", () => {
  it("gives ask and plan mode no tools at all", () => {
    for (const mode of ["ask", "plan"] as const) {
      assert.deepEqual(
        buildSessionTools(session(), FULL_CAPABILITIES, {
          mode,
          updatePlan: () => {},
          enterPlanMode: () => {},
        }),
        [],
      );
    }
  });

  it("gives agent mode enter_plan_mode first, then update_plan and the rest", () => {
    const tools = names(
      buildSessionTools(session(), FULL_CAPABILITIES, {
        mode: "agent",
        updatePlan: () => {},
        enterPlanMode: () => {},
      }),
    );
    assert.equal(tools[0], "enter_plan_mode");
    assert.equal(tools[1], "update_plan");
    assert.ok(tools.includes("read_file"));
    assert.ok(tools.includes("memory_read") && tools.includes("memory_write"));
  });

  it("skips mode gating and plan tools for background agents", () => {
    const tools = names(buildSessionTools(session(), FULL_CAPABILITIES, { mode: null }));
    assert.ok(!tools.includes("enter_plan_mode"));
    assert.ok(!tools.includes("update_plan"));
    assert.ok(tools.includes("read_file"));
  });
});
