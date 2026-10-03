import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectDockerEnvironment,
  detectToolEnvironment,
  findCommandsOnPath,
  inventoryEnvironmentVariables,
  type CommandProbe,
} from "../../../src/core/tools/environment.js";

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

describe("findCommandsOnPath", () => {
  it("finds executables in PATH order without starting a shell", { skip: process.platform === "win32" && "no execute bits on Windows" }, async () => {
    const first = mkdtempSync(join(tmpdir(), "nova-path-a-"));
    const second = mkdtempSync(join(tmpdir(), "nova-path-b-"));
    writeFileSync(join(first, "git"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(second, "git"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(second, "jq"), "not executable", { mode: 0o644 });

    const found = await findCommandsOnPath(["git", "jq", "rg"], [first, second, join(first, "missing")], "linux");
    assert.deepEqual(found.commandPaths.git, [join(first, "git"), join(second, "git")]);
    assert.equal(found.commands.jq, false, "a file without the execute bit is not a command");
    assert.equal(found.commands.rg, false);
  });

  it("uses PATHEXT and ignores case on Windows", async () => {
    const folder = mkdtempSync(join(tmpdir(), "nova-path-win-"));
    writeFileSync(join(folder, "Docker.EXE"), "");
    writeFileSync(join(folder, "npm.cmd"), "");
    writeFileSync(join(folder, "node.txt"), "");

    const found = await findCommandsOnPath(["docker", "npm", "node"], [folder], "win32", ".COM;.EXE;.BAT;.CMD");
    assert.deepEqual(found.commandPaths.docker, [join(folder, "Docker.EXE")]);
    assert.deepEqual(found.commandPaths.npm, [join(folder, "npm.cmd")]);
    assert.equal(found.commands.node, false);
  });
});

describe("detectToolEnvironment", () => {
  it("starts no Docker probe until inspect_environment asks for it", async () => {
    const environment = await detectToolEnvironment(process.cwd(), undefined);
    assert.equal(environment.docker.installed, false);
    assert.equal(typeof environment.loadDocker, "function");
  });
});
