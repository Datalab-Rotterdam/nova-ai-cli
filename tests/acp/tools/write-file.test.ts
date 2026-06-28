import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFileTool } from "../../../src/acp/tools/write-file.js";
import type { ToolHost } from "../../../src/core/tool-host.js";
import { makeToolContext } from "./test-helpers.js";

function makeContext(writeTextFile: ToolHost["writeTextFile"]) {
  return makeToolContext({ host: { writeTextFile } });
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
      assert.equal(path, "/tmp/x");
      assert.equal(content, "hello");
    });

    const result = await writeFileTool.execute(ctx, { path: "/tmp/x", content: "hello" });

    assert.deepEqual(result, { output: "Wrote 5 characters to /tmp/x." });
  });

  it("returns an error when the host write rejects", async () => {
    const ctx = makeContext(async () => {
      throw new Error("permission denied");
    });

    const result = await writeFileTool.execute(ctx, { path: "/tmp/x", content: "hi" });

    assert.deepEqual(result, { error: "permission denied" });
  });
});
