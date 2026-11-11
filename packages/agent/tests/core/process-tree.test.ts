import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import {
  liveChildCount,
  spawnCommand,
  terminateProcessTree,
} from "../../src/core/process-tree.js";

const posix = process.platform !== "win32";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 3_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

function firstLine(child: ReturnType<typeof spawnCommand>): Promise<string> {
  return new Promise((resolve) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline >= 0) resolve(output.slice(0, newline).trim());
    });
  });
}

describe("process tree", () => {
  it("terminates grandchildren started by the shell", { skip: !posix }, async () => {
    const child = spawnCommand("sleep 30 & echo $!; wait", { cwd: process.cwd() });
    const grandchild = Number(await firstLine(child));
    assert.ok(Number.isInteger(grandchild) && grandchild > 0);
    assert.ok(isAlive(grandchild));

    await terminateProcessTree(child);
    assert.ok(await waitUntil(() => !isAlive(grandchild)), "grandchild must be gone");
  });

  it("escalates to SIGKILL when SIGTERM is ignored", { skip: !posix }, async () => {
    const child = spawnCommand("trap '' TERM; echo ready; while :; do sleep 1; done", {
      cwd: process.cwd(),
    });
    assert.equal(await firstLine(child), "ready");
    const started = Date.now();
    await terminateProcessTree(child, 100);
    assert.ok(await waitUntil(() => child.exitCode !== null || child.signalCode !== null));
    assert.ok(Date.now() - started < 2_000);
  });

  it("closes stdin so prompting commands finish instead of hanging", async () => {
    const child = spawnCommand(posix ? "cat" : "more", { cwd: process.cwd() });
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
  });

  it("runs commands with explicit args without a shell", async () => {
    const child = spawnCommand(process.execPath, {
      cwd: process.cwd(),
      args: ["-e", "process.stdout.write(process.argv[1])", "a;b && c"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    await once(child, "exit");
    assert.equal(output, "a;b && c");
  });

  it("forgets children once they exit", async () => {
    const before = liveChildCount();
    const child = spawnCommand(process.execPath, { cwd: process.cwd(), args: ["-e", ""] });
    assert.equal(liveChildCount(), before + 1);
    await once(child, "exit");
    assert.equal(liveChildCount(), before);
  });
});
