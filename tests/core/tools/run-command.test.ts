import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCommandTool } from "../../../src/core/tools/run-command.js";
import type { ToolHost } from "../../../src/core/tool-host.js";
import { makeToolContext } from "./test-helpers.js";

function makeContext(runCommand: ToolHost["runCommand"]) {
  return makeToolContext({ host: { runCommand } });
}

describe("runCommandTool", () => {
  it("errors without calling the host when command is missing", async () => {
    let called = false;
    const ctx = makeContext(async () => {
      called = true;
      return { output: "", truncated: false, exitCode: 0 };
    });

    const result = await runCommandTool.execute(ctx, {});

    assert.deepEqual(result, { error: "run_command requires a 'command' argument." });
    assert.equal(called, false);
  });

  it("runs the command and returns combined output with exit code", async () => {
    const ctx = makeContext(async (command) => {
      assert.equal(command, "echo hello");
      return { output: "hello\n", truncated: false, exitCode: 0 };
    });

    const result = await runCommandTool.execute(ctx, { command: "echo hello" });

    assert.deepEqual(result, { output: "hello\n (exit code 0)" });
  });

  it("notes truncated output", async () => {
    const ctx = makeContext(async () => ({ output: "lots of output", truncated: true, exitCode: 1 }));

    const result = await runCommandTool.execute(ctx, { command: "yes" });

    assert.deepEqual(result, { output: "lots of output\n[output truncated] (exit code 1)" });
  });

  it("notes commands that were stopped by their timeout", async () => {
    const ctx = makeContext(async (_command, _signal, options) => {
      assert.equal(options?.timeoutMs, 5_000);
      return { output: "partial", truncated: false, exitCode: null, timedOut: true };
    });
    const result = await runCommandTool.execute(ctx, { command: "slow", timeout_seconds: 5 });
    assert.deepEqual(result, { output: "partial\n[timed out: the command was stopped]" });
  });

  it("returns an error when the host run rejects", async () => {
    const ctx = makeContext(async () => {
      throw new Error("spawn failed");
    });

    const result = await runCommandTool.execute(ctx, { command: "bad" });

    assert.deepEqual(result, { error: "spawn failed" });
  });
});
