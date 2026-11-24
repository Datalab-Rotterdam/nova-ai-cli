import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describeMention, findWorkspaceFileMentions } from "../../src/tui/files/file-mentions.js";
import { stripPromptNote, withPromptNote } from "../../src/tui/files/prompt-note.js";
import { formatShellResult, runUserShell, shellContext } from "../../src/tui/files/user-shell.js";

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
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("folder mentions list their entries; the note is hidden from the transcript", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-file-mentions-"));
  try {
    mkdirSync(join(cwd, "src", "lib"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "a");
    writeFileSync(join(cwd, "bin.dat"), "x\u0000y");
    const [folder, binary] = findWorkspaceFileMentions("look at @src/ and @bin.dat", cwd);
    assert.ok(folder?.isDirectory && binary && !binary.isDirectory);
    assert.equal(
      await describeMention(folder, async () => ""),
      `The user points at the folder @src (${join(cwd, "src")}), which holds: a.ts, lib/`,
    );
    assert.match(await describeMention(binary, async (path) => readFileSync(path, "utf8")), /binary file/);

    const sent = withPromptNote("look at @src/", ["secret context"]);
    assert.equal(stripPromptNote(sent), "look at @src/");
    assert.equal(stripPromptNote("no note"), "no note");
    // Notes from the desktop app and the agent are hidden too, also when a title cuts one off.
    assert.equal(stripPromptNote("/init\n\n<nova-command-note>\ndo it\n</nova-command-note>"), "/init");
    assert.equal(stripPromptNote("fix it\n\n<nova-desktop-note>\nThe user att"), "fix it");
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("! shell runs capture output and exit code, and Esc stops them", async () => {
  const done = await runUserShell("echo hello", process.cwd(), new AbortController().signal);
  assert.equal(done.exitCode, 0);
  assert.match(done.output, /hello/);
  assert.match(formatShellResult(done), /^```console\nhello\n```$/);
  assert.match(shellContext(done), /^\$ echo hello\nhello\n\(exit code 0\)$/);

  const failed = await runUserShell("exit 3", process.cwd(), new AbortController().signal);
  assert.match(formatShellResult(failed), /_Exit code 3_/);

  const abort = new AbortController();
  const slow = runUserShell(`"${process.execPath}" -e "setTimeout(()=>{},30000)"`, process.cwd(), abort.signal);
  setTimeout(() => abort.abort(), 200);
  assert.equal((await slow).stopped, true);
});

test("file mentions reject missing files and paths outside the workspace", () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-file-mentions-"));
  try {
    assert.deepEqual(findWorkspaceFileMentions("@../secret.txt @missing.txt", cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
