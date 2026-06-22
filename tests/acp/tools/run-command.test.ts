import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { runCommandTool } from "../../../src/acp/tools/run-command.js";
import type { ToolContext } from "../../../src/acp/tools/types.js";

function makeContext(request: (method: string, params: any) => Promise<any>): ToolContext {
  return {
    client: { request } as unknown as acp.AgentContext,
    sessionId: "session-1",
    signal: new AbortController().signal,
  };
}

describe("runCommandTool", () => {
  it("errors without calling the client when command is missing", async () => {
    let called = false;
    const ctx = makeContext(async () => {
      called = true;
      return {};
    });

    const result = await runCommandTool.execute(ctx, {});

    assert.deepEqual(result, { error: "run_command requires a 'command' argument." });
    assert.equal(called, false);
  });

  it("drives terminal create -> waitForExit -> output -> release and returns combined output", async () => {
    const calls: string[] = [];
    const ctx = makeContext(async (method) => {
      calls.push(method);
      switch (method) {
        case "terminal/create":
          return { terminalId: "term-1" };
        case "terminal/wait_for_exit":
          return { exitCode: 0 };
        case "terminal/output":
          return { output: "hello\n", truncated: false };
        case "terminal/release":
          return {};
        default:
          throw new Error(`unexpected method ${method}`);
      }
    });

    const result = await runCommandTool.execute(ctx, { command: "echo hello" });

    assert.deepEqual(result, { output: "hello\n (exit code 0)" });
    assert.deepEqual(calls, ["terminal/create", "terminal/wait_for_exit", "terminal/output", "terminal/release"]);
  });

  it("notes truncated output", async () => {
    const ctx = makeContext(async (method) => {
      switch (method) {
        case "terminal/create":
          return { terminalId: "term-1" };
        case "terminal/wait_for_exit":
          return { exitCode: 1 };
        case "terminal/output":
          return { output: "lots of output", truncated: true };
        default:
          return {};
      }
    });

    const result = await runCommandTool.execute(ctx, { command: "yes" });

    assert.deepEqual(result, { output: "lots of output\n[output truncated] (exit code 1)" });
  });

  it("returns an error when terminal/create rejects, and still attempts no release", async () => {
    const ctx = makeContext(async (method) => {
      if (method === "terminal/create") throw new Error("spawn failed");
      throw new Error(`unexpected method ${method}`);
    });

    const result = await runCommandTool.execute(ctx, { command: "bad" });

    assert.deepEqual(result, { error: "spawn failed" });
  });
});
