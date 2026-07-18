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
        commandPaths: {
          git: ["C:\\Program Files\\Git\\cmd\\git.exe"],
          npm: ["C:\\Program Files\\nodejs\\npm.cmd"],
          pnpm: [],
        },
        environmentVariableNames: ["ComSpec", "Path", "SECRET_TOKEN"],
        toolingEnvironmentVariables: {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
        pathEntries: ["C:\\Program Files\\Git\\cmd", "C:\\Windows\\System32"],
        docker: {
          installed: true,
          clientVersion: "Docker version 28.3.3, build test",
          daemonAvailable: true,
          serverVersion: "28.3.3",
          osType: "linux",
          architecture: "x86_64",
          context: "desktop-linux",
          composeCommand: "docker compose",
          composeVersion: "v2.38.1",
        },
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
    assert.match(result.output, /git: C:\\Program Files\\Git\\cmd\\git\.exe/);
    assert.match(
      result.output,
      /Environment variables \(names only\): ComSpec, Path, SECRET_TOKEN/,
    );
    assert.match(result.output, /COMSPEC=C:\\Windows\\System32\\cmd\.exe/);
    assert.match(result.output, /PATH entries \(2\):/);
    assert.doesNotMatch(result.output, /SECRET_TOKEN=/);
    assert.match(result.output, /Docker daemon: available; server=28\.3\.3; platform=linux\/x86_64/);
    assert.match(result.output, /Docker Compose: docker compose v2\.38\.1/);
    assert.match(result.output, /Container execution: available through run_command \(permission required\)/);
    assert.match(result.output, /run_package_script: available/);
  });
});
