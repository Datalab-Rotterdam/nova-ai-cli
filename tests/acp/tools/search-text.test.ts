import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { searchTextTool } from "../../../src/acp/tools/search-text.js";
import { makeToolContext } from "./test-helpers.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nova-search-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("searchTextTool", () => {
  it("finds literal matches and skips excluded directories", async () => {
    const cwd = await makeWorkspace();
    await mkdir(join(cwd, "src"));
    await mkdir(join(cwd, "node_modules"));
    await writeFile(join(cwd, "src", "app.ts"), "const label = 'Hello';\n");
    await writeFile(join(cwd, "node_modules", "dep.ts"), "Hello from dependency\n");
    const ctx = makeToolContext({ cwd });

    const result = await searchTextTool.execute(ctx, { query: "hello", include_extensions: [".ts"] });

    assert.ok("output" in result);
    assert.match(result.output, /src[\\/]app\.ts:1:16/);
    assert.doesNotMatch(result.output, /node_modules/);
  });

  it("supports regex search with match limits", async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, "a.txt"), "alpha\nbeta\nalphabet\n");
    const ctx = makeToolContext({ cwd });

    const result = await searchTextTool.execute(ctx, { query: "alp\\w+", regex: true, max_matches: 1 });

    assert.ok("output" in result);
    assert.match(result.output, /a\.txt:1:1/);
    assert.match(result.output, /\[stopped after 1 matches\]/);
  });

  it("rejects paths outside the workspace", async () => {
    const cwd = await makeWorkspace();
    const ctx = makeToolContext({ cwd });

    const result = await searchTextTool.execute(ctx, { query: "x", path: ".." });

    assert.deepEqual(result, { error: "Path is outside the workspace: .." });
  });
});
