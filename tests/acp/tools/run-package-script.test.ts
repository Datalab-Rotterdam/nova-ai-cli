import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPackageScriptCommand, runPackageScriptTool } from "../../../src/acp/tools/run-package-script.js";
import { makeToolContext } from "./test-helpers.js";

describe("runPackageScriptTool", () => {
  it("rejects a missing script argument", async () => {
    let called = false;
    const ctx = makeToolContext({
      host: {
        runCommand: async () => {
          called = true;
          return { output: "", truncated: false, exitCode: 0 };
        },
      },
    });

    const result = await runPackageScriptTool.execute(ctx, {});

    assert.deepEqual(result, { error: "run_package_script requires a 'script' argument." });
    assert.equal(called, false);
  });

  it("rejects unknown scripts", async () => {
    const ctx = makeToolContext({ environment: { packageScripts: ["test"] } });

    const result = await runPackageScriptTool.execute(ctx, { script: "build" });

    assert.deepEqual(result, { error: 'Unknown package script "build". Available scripts: test' });
  });

  it("runs a known script with args and returns output with exit code", async () => {
    const ctx = makeToolContext({
      environment: { packageManager: "npm", packageScripts: ["test"], platform: "linux" },
      host: {
        runCommand: async (command) => {
          assert.equal(command, "npm run test -- --watch");
          return { output: "ok\n", truncated: false, exitCode: 0 };
        },
      },
    });

    const result = await runPackageScriptTool.execute(ctx, { script: "test", args: ["--watch"] });

    assert.deepEqual(result, { output: "ok\n (exit code 0)" });
  });

  it("builds yarn and quoted Windows commands", () => {
    assert.equal(buildPackageScriptCommand("yarn", "test", ["--watch"], "linux"), "yarn run test --watch");
    assert.equal(buildPackageScriptCommand("npm", "test all", ["--flag=value"], "win32"), 'npm run "test all" -- --flag=value');
  });
});
