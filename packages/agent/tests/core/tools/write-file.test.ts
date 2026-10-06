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

describe("bundled skills", () => {
  it("refuses to write into a bundled skill, without calling the host", async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cwd = mkdtempSync(join(tmpdir(), "nova-bundled-"));
    try {
      const skill = join(cwd, ".nova-ai", "skills", "team-browser");
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, "SKILL.md"), "---\nname: team-browser\n---\nbody");
      writeFileSync(join(skill, ".nova-bundled.json"), JSON.stringify({ bundledBy: "Nova AI Browser" }));
      let called = false;
      const ctx = makeToolContext({ host: { writeTextFile: async () => { called = true; } }, cwd });

      const result = await writeFileTool.execute(ctx, { path: ".nova-ai/skills/team-browser/SKILL.md", content: "changed" });
      assert.ok("error" in result);
      assert.match(result.error, /bundled with Nova AI Browser.*only switched off/);
      assert.equal(called, false);

      const other = await writeFileTool.execute(ctx, { path: "notes.md", content: "ok" });
      assert.ok(!("error" in other));
      assert.equal(called, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
