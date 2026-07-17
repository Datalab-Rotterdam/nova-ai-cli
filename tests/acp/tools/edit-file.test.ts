import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { editFileTool } from "../../../src/acp/tools/edit-file.js";
import type { ToolHost } from "../../../src/core/tool-host.js";
import { makeToolContext } from "./test-helpers.js";

function makeContext(overrides: Partial<Pick<ToolHost, "readTextFile" | "writeTextFile">> = {}) {
  return makeToolContext({ host: overrides });
}

describe("editFileTool", () => {
  it("errors when path is missing", async () => {
    const ctx = makeContext();
    const result = await editFileTool.execute(ctx, { old_string: "a", new_string: "b" });
    assert.deepEqual(result, { error: "edit_file requires a 'path' argument." });
  });

  it("errors when old_string is missing", async () => {
    const ctx = makeContext();
    const result = await editFileTool.execute(ctx, { path: "/tmp/x", new_string: "b" });
    assert.deepEqual(result, { error: "edit_file requires a non-empty 'old_string' argument." });
  });

  it("errors when old_string is not found", async () => {
    const ctx = makeContext({ readTextFile: async () => "hello world" });
    const result = await editFileTool.execute(ctx, { path: "/tmp/x", old_string: "nope", new_string: "b" });
    assert.deepEqual(result, { error: "old_string not found in /tmp/x." });
  });

  it("errors when old_string matches more than once", async () => {
    const ctx = makeContext({ readTextFile: async () => "foo foo" });
    const result = await editFileTool.execute(ctx, { path: "/tmp/x", old_string: "foo", new_string: "bar" });
    assert.deepEqual(result, { error: "old_string matches 2 locations in /tmp/x; it must match exactly once." });
  });

  it("replaces the single match and returns a diff", async () => {
    let written: { path: string; content: string } | undefined;
    const ctx = makeContext({
      readTextFile: async () => "hello world",
      writeTextFile: async (path, content) => {
        written = { path, content };
      },
    });

    const result = await editFileTool.execute(ctx, { path: "/tmp/x", old_string: "world", new_string: "there" });

    assert.deepEqual(result, {
      output: "Edited /tmp/x.",
      diff: { path: "/tmp/x", oldText: "hello world", newText: "hello there" },
    });
    assert.deepEqual(written, { path: "/tmp/x", content: "hello there" });
  });

  it("returns an error when the host read rejects", async () => {
    const ctx = makeContext({
      readTextFile: async () => {
        throw new Error("not found");
      },
    });
    const result = await editFileTool.execute(ctx, { path: "/tmp/x", old_string: "a", new_string: "b" });
    assert.deepEqual(result, { error: "not found" });
  });

  it("returns an error when the host write rejects", async () => {
    const ctx = makeContext({
      readTextFile: async () => "hello world",
      writeTextFile: async () => {
        throw new Error("permission denied");
      },
    });
    const result = await editFileTool.execute(ctx, { path: "/tmp/x", old_string: "world", new_string: "there" });
    assert.deepEqual(result, { error: "permission denied" });
  });
});
