import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectEnvironmentTool } from "../../../src/acp/tools/inspect-environment.js";
import { makeToolContext } from "./test-helpers.js";

describe("inspectEnvironmentTool", () => {
  it("reports platform, capabilities, commands, and package scripts", async () => {
    const ctx = makeToolContext({
      environment: {
        platform: "win32",
        commands: { git: true, npm: true, pnpm: false },
        packageManager: "npm",
        packageScripts: ["build", "test"],
      },
    });

    const result = await inspectEnvironmentTool.execute(ctx, {});

    assert.ok("output" in result);
    assert.match(result.output, /Platform: win32/);
    assert.match(result.output, /Package manager: npm/);
    assert.match(result.output, /Package scripts: build, test/);
    assert.match(result.output, /Available commands: git, npm/);
    assert.match(result.output, /run_package_script: available/);
  });
});
