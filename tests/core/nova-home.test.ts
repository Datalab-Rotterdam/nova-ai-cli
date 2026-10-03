import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { projectPaths, slugify, workspaceKey } from "../../src/core/nova-home.js";
import {
  appendSessionTurn,
  deleteStoredSession,
  listStoredSessions,
  loadStoredSession,
} from "../../src/core/sessions.js";

describe("workspaceKey (must match nova-ai-vscode)", () => {
  it("is <slug>-<hash8>", () => {
    assert.match(workspaceKey("/tmp/My Project"), /^my-project-[0-9a-f]{8}$/);
  });

  it("ignores trailing separators and, on case-insensitive platforms, case", () => {
    assert.equal(workspaceKey("/x/Repo/", "linux"), workspaceKey("/x/Repo", "linux"));
    assert.equal(workspaceKey("/x/Repo", "darwin"), workspaceKey("/x/repo", "darwin"));
    assert.notEqual(workspaceKey("/x/Repo", "linux"), workspaceKey("/x/repo", "linux"));
  });

  it("slugifies like the extension", () => {
    assert.equal(slugify("  Hello  World!! "), "hello-world");
    assert.equal(slugify("...dots..."), "dots");
    assert.equal(slugify("a".repeat(60)).length, 40);
  });
});

describe("session storage layout", () => {
  let home: string;
  let workspace: string;
  const previous = { home: process.env.NOVA_AI_HOME, dir: process.env.NOVA_AI_CLI_SESSIONS_DIR };

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "nova-layout-"));
    home = join(base, "home");
    workspace = join(base, "workspace");
    mkdirSync(workspace, { recursive: true });
    process.env.NOVA_AI_HOME = home;
    delete process.env.NOVA_AI_CLI_SESSIONS_DIR;
  });

  afterEach(() => {
    rmSync(join(home, ".."), { recursive: true, force: true });
    if (previous.home === undefined) delete process.env.NOVA_AI_HOME;
    else process.env.NOVA_AI_HOME = previous.home;
    if (previous.dir === undefined) delete process.env.NOVA_AI_CLI_SESSIONS_DIR;
    else process.env.NOVA_AI_CLI_SESSIONS_DIR = previous.dir;
  });

  it("stores new sessions privately in the project's cli-sessions folder", () => {
    const id = crypto.randomUUID();
    appendSessionTurn(id, { cwd: workspace, title: "t" }, [{ role: "user", content: "hi" }]);
    const paths = projectPaths(workspace);
    const file = join(paths.cliSessions, `${id}.jsonl`);
    assert.ok(existsSync(file));
    assert.equal(JSON.parse(readFileSync(paths.info, "utf8")).path, workspace);
    const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]!);
    assert.equal(header.version, 1);
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    assert.equal(loadStoredSession(id)?.messages.length, 1);
  });

  it("keeps reading and appending to sessions in the legacy folder", () => {
    const id = crypto.randomUUID();
    const legacy = join(home, "sessions");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, `${id}.jsonl`),
      `${JSON.stringify({ kind: "header", cwd: workspace, title: "old" })}\n` +
        `${JSON.stringify({ kind: "message", updatedAt: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "old" } })}\n`,
    );
    assert.equal(loadStoredSession(id)?.title, "old");

    appendSessionTurn(id, { cwd: workspace, title: "old" }, [{ role: "user", content: "new" }]);
    assert.equal(loadStoredSession(id)?.messages.length, 2);
    assert.ok(!existsSync(join(projectPaths(workspace).cliSessions, `${id}.jsonl`)));
  });

  it("lists and deletes sessions across all locations", () => {
    const fresh = crypto.randomUUID();
    const other = crypto.randomUUID();
    const otherWorkspace = join(workspace, "..", "other");
    mkdirSync(otherWorkspace);
    appendSessionTurn(fresh, { cwd: workspace, title: "a" }, [{ role: "user", content: "a" }]);
    appendSessionTurn(other, { cwd: otherWorkspace, title: "b" }, [{ role: "user", content: "b" }]);

    assert.deepEqual(
      listStoredSessions().map((s) => s.sessionId).sort(),
      [fresh, other].sort(),
    );
    assert.deepEqual(listStoredSessions(workspace).map((s) => s.sessionId), [fresh]);

    deleteStoredSession(other);
    assert.equal(loadStoredSession(other), null);
    assert.deepEqual(listStoredSessions().map((s) => s.sessionId), [fresh]);
  });
});
