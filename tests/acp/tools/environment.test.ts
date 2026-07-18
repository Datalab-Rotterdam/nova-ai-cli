import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectDockerEnvironment,
  inventoryEnvironmentVariables,
  type CommandProbe,
} from "../../../src/acp/tools/environment.js";

describe("inventoryEnvironmentVariables", () => {
  it("handles case-insensitive Windows variables and de-duplicates PATH entries", () => {
    const inventory = inventoryEnvironmentVariables(
      {
        Path: '"C:\\Tools";C:\\Windows\\System32;c:\\tools;',
        PathExt: ".COM;.EXE;.BAT;.CMD",
        Pnpm_Home: "C:\\Users\\test\\pnpm",
        SECRET_TOKEN: "must-not-be-exposed",
      },
      "win32",
    );

    assert.deepEqual(inventory.pathEntries, [
      "C:\\Tools",
      "C:\\Windows\\System32",
    ]);
    assert.deepEqual(inventory.toolingEnvironmentVariables, {
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PNPM_HOME: "C:\\Users\\test\\pnpm",
    });
    assert.deepEqual(inventory.environmentVariableNames, [
      "Path",
      "PathExt",
      "Pnpm_Home",
      "SECRET_TOKEN",
    ]);
    assert.equal(
      Object.values(inventory.toolingEnvironmentVariables).includes(
        "must-not-be-exposed",
      ),
      false,
    );
  });
});

describe("detectDockerEnvironment", () => {
  it("reports a reachable Docker daemon, server platform, context, and Compose", async () => {
    const calls: string[] = [];
    const probe: CommandProbe = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (args[0] === "--version") {
        return { exitCode: 0, output: "Docker version 28.3.3, build test\n" };
      }
      if (args[0] === "info") {
        return { exitCode: 0, output: "28.3.3\tlinux\tx86_64\n" };
      }
      if (args[0] === "context") {
        return { exitCode: 0, output: "desktop-linux\n" };
      }
      if (args[0] === "compose") {
        return { exitCode: 0, output: "v2.38.1\n" };
      }
      return { exitCode: 1, output: "" };
    };

    const docker = await detectDockerEnvironment(true, false, probe);

    assert.deepEqual(docker, {
      installed: true,
      clientVersion: "Docker version 28.3.3, build test",
      daemonAvailable: true,
      serverVersion: "28.3.3",
      osType: "linux",
      architecture: "x86_64",
      context: "desktop-linux",
      composeCommand: "docker compose",
      composeVersion: "v2.38.1",
    });
    assert.equal(calls.length, 4);
  });
});
