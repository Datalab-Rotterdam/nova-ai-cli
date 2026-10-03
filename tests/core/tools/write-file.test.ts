import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { writeFileTool } from "../../../src/core/tools/write-file.js";
import type { ToolHost } from "../../../src/core/tool-host.js";
import { makeToolContext } from "./test-helpers.js";

/** The tools resolve paths for the platform: "/tmp/x" becomes D:\tmp\x on Windows. */
const FILE = resolve("/tmp/x");

function makeContext(writeTextFile: ToolHost["writeTextFile"]) {
  return makeToolContext({ host: { writeTextFile }, cwd: "/tmp" });
}

describe("writeFileTool", () => {
  it("errors without calling the host when path is missing", async () => {
    let called = false;
    const ctx = makeContext(async () => {
      called = true;
    });

    const result = await writeFileTool.execute(ctx, { content: "hi" });

    assert.deepEqual(result, { error: "write_file requires a 'path' argument." });
    assert.equal(called, false);
  });

  it("writes the file with path and content", async () => {
    const ctx = makeContext(async (path, content) => {
      assert.equal(path, FILE);
      assert.equal(content, "hello");
    });

    const result = await writeFileTool.execute(ctx, { path: FILE, content: "hello" });

    assert.deepEqual(result, {
      output: `Wrote 5 characters to ${FILE}.`,
      diff: { path: FILE, oldText: "", newText: "hello" },
    });
  });

  it("returns an error when the host write rejects", async () => {
    const ctx = makeContext(async () => {
      throw new Error("permission denied");
    });

    const result = await writeFileTool.execute(ctx, { path: FILE, content: "hi" });

    assert.deepEqual(result, { error: "permission denied" });
  });
});
