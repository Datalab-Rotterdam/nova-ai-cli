import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readFileTool } from "../../../src/core/tools/read-file.js";
import { writeFileTool } from "../../../src/core/tools/write-file.js";
import { resolveWorkspaceFile } from "../../../src/core/tools/workspace-paths.js";
import { makeToolContext } from "./test-helpers.js";

const base = mkdtempSync(join(tmpdir(), "nova-paths-"));
const workspace = join(base, "workspace");
const outside = join(base, "outside");
mkdirSync(join(workspace, "src"), { recursive: true });
mkdirSync(outside);
writeFileSync(join(outside, "secret.txt"), "secret");
after(() => rmSync(base, { recursive: true, force: true }));

const posix = process.platform !== "win32";

describe("resolveWorkspaceFile", () => {
  it("resolves relative paths against the session cwd", async () => {
    assert.deepEqual(await resolveWorkspaceFile(workspace, "src/a.ts"), {
      path: join(workspace, "src", "a.ts"),
    });
  });

  it("accepts absolute paths inside the workspace, including new files", async () => {
    const path = join(workspace, "new", "dir", "file.ts");
    assert.deepEqual(await resolveWorkspaceFile(workspace, path), { path });
  });

  it("refuses paths outside the workspace", async () => {
    for (const input of ["../outside/secret.txt", join(outside, "secret.txt"), "/etc/passwd"]) {
      const result = await resolveWorkspaceFile(workspace, input);
      assert.ok("error" in result, input);
    }
  });

  it("refuses empty paths", async () => {
    assert.ok("error" in (await resolveWorkspaceFile(workspace, "")));
    assert.ok("error" in (await resolveWorkspaceFile(workspace, undefined)));
  });

  it("refuses symlinks that point outside the workspace", { skip: !posix }, async () => {
    symlinkSync(outside, join(workspace, "link-dir"));
    symlinkSync(join(outside, "secret.txt"), join(workspace, "link-file"));
    for (const input of ["link-dir/secret.txt", "link-file", "link-dir/new-file.txt"]) {
      const result = await resolveWorkspaceFile(workspace, input);
      assert.ok("error" in result, input);
    }
  });

  it("allows symlinks that stay inside the workspace", { skip: !posix }, async () => {
    symlinkSync(join(workspace, "src"), join(workspace, "src-link"));
    const result = await resolveWorkspaceFile(workspace, "src-link/a.ts");
    assert.deepEqual(result, { path: join(workspace, "src-link", "a.ts") });
  });
});

describe("file tools stay inside the workspace", () => {
  it("read_file never asks the host for a file outside the workspace", async () => {
    const requested: string[] = [];
    const ctx = makeToolContext({
      cwd: workspace,
      host: { readTextFile: async (path) => (requested.push(path), "x") },
    });
    const result = await readFileTool.execute(ctx, { path: join(outside, "secret.txt") });
    assert.ok("error" in result);
    assert.deepEqual(requested, []);
  });

  it("write_file never asks the host to write outside the workspace", async () => {
    const written: string[] = [];
    const ctx = makeToolContext({
      cwd: workspace,
      host: { writeTextFile: async (path) => void written.push(path) },
    });
    const result = await writeFileTool.execute(ctx, { path: "../outside/x.txt", content: "x" });
    assert.ok("error" in result);
    assert.deepEqual(written, []);
  });

  it("read_file passes an absolute workspace path for relative input", async () => {
    const requested: string[] = [];
    const ctx = makeToolContext({
      cwd: workspace,
      host: { readTextFile: async (path) => (requested.push(path), "x") },
    });
    await readFileTool.execute(ctx, { path: "src/a.ts" });
    assert.deepEqual(requested, [join(workspace, "src", "a.ts")]);
  });
});

describe("resolveWorkspaceFile with a workspace that does not exist yet", () => {
  it("accepts files inside it", async () => {
    const missing = join(base, "not-created-yet");
    const path = join(missing, "a.txt");
    assert.deepEqual(await resolveWorkspaceFile(missing, path), { path });
  });
});
