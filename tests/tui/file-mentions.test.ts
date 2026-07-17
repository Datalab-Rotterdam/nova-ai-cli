import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findWorkspaceFileMentions } from "../../src/tui/files/file-mentions.js";

test("file mentions resolve directly with normalized and quoted workspace paths", () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-file-mentions-"));
  try {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "one.ts"), "one");
    writeFileSync(join(cwd, "file with spaces.md"), "spaces");

    const mentions = findWorkspaceFileMentions(
      'inspect @./src\\one.ts, then @"file with spaces.md" and dedupe @src/one.ts',
      cwd,
    );
    assert.deepEqual(mentions.map((mention) => mention.relativePath), ["src/one.ts", "file with spaces.md"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("file mentions reject missing files and paths outside the workspace", () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-file-mentions-"));
  try {
    assert.deepEqual(findWorkspaceFileMentions("@../secret.txt @missing.txt", cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
