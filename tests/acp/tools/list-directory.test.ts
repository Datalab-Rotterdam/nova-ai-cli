import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { listDirectoryTool } from "../../../src/acp/tools/list-directory.js";
import { makeToolContext } from "./test-helpers.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nova-list-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("listDirectoryTool", () => {
  it("lists visible files and directories with a cap", async () => {
    const cwd = await makeWorkspace();
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "a.txt"), "hello");
    await writeFile(join(cwd, ".hidden"), "secret");
    const ctx = makeToolContext({ cwd });

    const result = await listDirectoryTool.execute(ctx, { max_entries: 1 });

    assert.ok("output" in result);
    assert.match(result.output, /dir\s+src\//);
    assert.match(result.output, /\[1 entries omitted\]/);
    assert.doesNotMatch(result.output, /\.hidden/);
  });

  it("rejects paths outside the workspace", async () => {
    const cwd = await makeWorkspace();
    const ctx = makeToolContext({ cwd });

    const result = await listDirectoryTool.execute(ctx, { path: ".." });

    assert.deepEqual(result, { error: "Path is outside the workspace: .." });
  });
});
