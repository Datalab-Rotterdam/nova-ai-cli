import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileTool } from "../../../src/acp/tools/read-file.js";
import type { ToolHost } from "../../../src/core/tool-host.js";
import { makeToolContext } from "./test-helpers.js";

function makeContext(readTextFile: ToolHost["readTextFile"]) {
  return makeToolContext({ host: { readTextFile } });
}

describe("readFileTool", () => {
  it("errors without calling the host when path is missing", async () => {
    let called = false;
    const ctx = makeContext(async () => {
      called = true;
      return "";
    });

    const result = await readFileTool.execute(ctx, {});

    assert.deepEqual(result, { error: "read_file requires a 'path' argument." });
    assert.equal(called, false);
  });

  it("reads the file and returns the content", async () => {
    const ctx = makeContext(async (path) => {
      assert.equal(path, "/tmp/x");
      return "hello";
    });

    const result = await readFileTool.execute(ctx, { path: "/tmp/x" });

    assert.deepEqual(result, { output: "hello" });
  });

  it("returns an error when the host read rejects", async () => {
    const ctx = makeContext(async () => {
      throw new Error("file not found");
    });

    const result = await readFileTool.execute(ctx, { path: "/tmp/missing" });

    assert.deepEqual(result, { error: "file not found (path tried: /tmp/missing)" });
  });
});
