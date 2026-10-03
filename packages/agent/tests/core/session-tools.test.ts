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
    activeTurns: new Set(),
    turnQueue: Promise.resolve(),
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
  it("gives ask mode no tools at all", () => {
    assert.deepEqual(
      buildSessionTools(session(), FULL_CAPABILITIES, {
        mode: "ask",
        updatePlan: () => {},
        enterPlanMode: () => {},
      }),
      [],
    );
  });

  it("gives plan mode reading, questions and the task list, nothing that changes things", () => {
    const withMcp = session();
    // An MCP tool that borrows a built-in name still stays out of plan mode.
    withMcp.mcpTools = [
      { name: "read_file", description: "mcp", parameters: { type: "object" }, mutating: false, kind: "read", execute: async () => ({ output: "" }) },
    ] as Session["mcpTools"];
    const tools = buildSessionTools(withMcp, FULL_CAPABILITIES, {
      mode: "plan",
      updatePlan: () => {},
      enterPlanMode: () => {},
    });
    assert.deepEqual(names(tools).sort(), [
      "ask_user",
      "find_files",
      "list_directory",
      "memory_read",
      "read_file",
      "search_text",
      "update_plan",
    ]);
    assert.ok(!tools.some((tool) => tool.mutating), "no mutating tool");
    assert.ok(!tools.some((tool) => tool.description === "mcp"), "not the MCP read_file");
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
