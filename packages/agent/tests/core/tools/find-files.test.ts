import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findFilesTool } from "../../../src/core/tools/find-files.js";
import { globToRegExp } from "../../../src/core/tools/glob.js";
import { makeToolContext } from "./test-helpers.js";

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nova-find-"));
  for (const path of [
    "README.md",
    "src/app.ts",
    "src/app.test.ts",
    "src/lib/util.ts",
    "src/lib/util.test.ts",
    "docs/guide.md",
    "node_modules/pkg/index.ts",
    "dist/app.js",
    ".git/config",
  ]) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), "");
  }
  return root;
}

const run = async (cwd: string, pattern: string, extra: Record<string, unknown> = {}) => {
  const result = await findFilesTool.execute(makeToolContext({ cwd }), { pattern, ...extra });
  return "output" in result ? result.output : `ERROR ${result.error}`;
};

describe("glob", () => {
  it("keeps * and ? inside one segment and lets ** span folders", () => {
    assert.ok(globToRegExp("src/*.ts").test("src/app.ts"));
    assert.ok(!globToRegExp("src/*.ts").test("src/lib/util.ts"));
    assert.ok(globToRegExp("src/**/*.ts").test("src/app.ts"));
    assert.ok(globToRegExp("src/**/*.ts").test("src/lib/util.ts"));
    assert.ok(globToRegExp("**/*.{md,txt}").test("docs/guide.md"));
    assert.ok(globToRegExp("file?.[jt]s").test("file1.ts"));
    assert.ok(!globToRegExp("file[!0-9].ts").test("file1.ts"));
    assert.ok(globToRegExp("a+b(c).ts").test("a+b(c).ts"), "regex characters are literal");
  });
});

describe("find_files", () => {
  it("finds by path glob and by bare file name, skipping dependencies and build output", async () => {
    const cwd = workspace();
    assert.equal(await run(cwd, "**/*.test.ts"), "src/app.test.ts\nsrc/lib/util.test.ts");
    assert.equal(await run(cwd, "*.md"), "README.md\ndocs/guide.md", "a pattern without / matches names anywhere");
    assert.equal(await run(cwd, "src/*.ts"), "src/app.test.ts\nsrc/app.ts");
    assert.equal(await run(cwd, "**/index.ts"), "No files found.");
    assert.equal(await run(cwd, "**/*.js"), "No files found.");
  });

  it("limits results and refuses patterns that leave the workspace", async () => {
    const cwd = workspace();
    assert.match(await run(cwd, "**/*.ts", { max_results: 1 }), /^src\/app\.test\.ts\n\[More than 1 results/);
    assert.match(await run(cwd, "../**/*.ts"), /^ERROR .*may not contain ".."/);
    assert.match(await run(cwd, "  "), /^ERROR .*requires a glob/);
  });

  it("does not follow symbolic links out of the workspace", { skip: process.platform === "win32" && "symlinks need privileges on Windows" }, async () => {
    const cwd = workspace();
    const outside = mkdtempSync(join(tmpdir(), "nova-outside-"));
    writeFileSync(join(outside, "secret.ts"), "");
    symlinkSync(outside, join(cwd, "linked"));
    assert.equal(await run(cwd, "**/secret.ts"), "No files found.");
  });
});
