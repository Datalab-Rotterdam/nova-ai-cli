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
    assert.ok("error" in result);
    if ("error" in result) {
      assert.match(result.error, /matches 2 locations in \/tmp\/x \(lines 1, 1\)/);
      assert.match(result.error, /replace_all/);
    }
  });

  it("replaces every occurrence with replace_all", async () => {
    let written = "";
    const ctx = makeContext({
      readTextFile: async () => "foo bar foo baz foo",
      writeTextFile: async (_path, content) => {
        written = content;
      },
    });
    const result = await editFileTool.execute(ctx, {
      path: "/tmp/x",
      old_string: "foo",
      new_string: "qux",
      replace_all: true,
    });
    assert.ok("output" in result);
    assert.equal(written, "qux bar qux baz qux");
  });

  it("keeps $-patterns in new_string literal", async () => {
    let written = "";
    const ctx = makeContext({
      readTextFile: async () => "total = X",
      writeTextFile: async (_path, content) => {
        written = content;
      },
    });
    const result = await editFileTool.execute(ctx, {
      path: "/tmp/x",
      old_string: "X",
      new_string: "$$total & $&",
    });
    assert.ok("output" in result);
    assert.equal(written, "total = $$total & $&");
  });

  it("matches across CRLF/LF line-ending differences and preserves file endings", async () => {
    let written = "";
    const ctx = makeContext({
      readTextFile: async () => "alpha\r\nbeta\r\ngamma\r\n",
      writeTextFile: async (_path, content) => {
        written = content;
      },
    });
    const result = await editFileTool.execute(ctx, {
      path: "/tmp/x",
      old_string: "alpha\nbeta",
      new_string: "alpha\nBETA",
    });
    assert.ok("output" in result);
    assert.equal(written, "alpha\r\nBETA\r\ngamma\r\n");
  });

  it("matches an indentation-shifted unique window and re-indents new_string", async () => {
    let written = "";
    const ctx = makeContext({
      readTextFile: async () => "function f() {\n    if (x) {\n      go();\n    }\n}\n",
      writeTextFile: async (_path, content) => {
        written = content;
      },
    });
    const result = await editFileTool.execute(ctx, {
      path: "/tmp/x",
      old_string: "if (x) {\n  go();\n}",
      new_string: "if (x) {\n  stop();\n}",
    });
    assert.ok("output" in result);
    assert.equal(written, "function f() {\n    if (x) {\n      stop();\n    }\n}\n");
  });

  it("reports every ambiguous whitespace-tolerant window", async () => {
    const ctx = makeContext({
      readTextFile: async () => "  a();\nx\n    a();\n",
    });
    const result = await editFileTool.execute(ctx, {
      path: "/tmp/x",
      old_string: "a();\nnope",
      new_string: "b();",
    });
    assert.ok("error" in result);
    if ("error" in result) assert.match(result.error, /not found/);

    const ambiguous = await editFileTool.execute(
      makeContext({ readTextFile: async () => "  a();\nx\n    a();\n" }),
      { path: "/tmp/x", old_string: "a();", new_string: "b();" },
    );
    assert.ok("error" in ambiguous);
    if ("error" in ambiguous) {
      assert.match(ambiguous.error, /matches 2 locations in \/tmp\/x \(lines 1, 3\)/);
    }
  });

  it("returns the closest window snippet when nothing matches", async () => {
    const ctx = makeContext({
      readTextFile: async () =>
        "const a = 1;\nif (expectedNonce && token.nonce !== expectedNonce) {\n  throw new Error();\n}\n",
    });
    const result = await editFileTool.execute(ctx, {
      path: "/tmp/x",
      old_string: "if (expectedNonce && token.nonce != expectedNonce) {\n  throw new Error();\n}",
      new_string: "whatever",
    });
    assert.ok("error" in result);
    if ("error" in result) {
      assert.match(result.error, /Closest match \(lines 2-4, 1 of 3 lines differ\)/);
      assert.match(result.error, /token\.nonce !== expectedNonce/);
      assert.match(result.error, /Adjust old_string to match the file exactly/);
    }
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
