import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import {
  applyMemoryChange,
  buildMemorySystemPrompt,
  createMemoryReadTool,
  createMemoryWriteTool,
  loadMemory,
  memoryPaths,
  sessionMemory,
} from "../../src/core/memory.js";
import { projectPaths } from "../../src/core/nova-home.js";
import { makeToolContext } from "./tools/test-helpers.js";

/** Exactly what nova-ai-vscode's MemoryService writes for a new project file. */
const EXTENSION_PROJECT_FILE =
  "# Nova memory (this project)\n\nPrivate notes about this project, kept outside the repository.\nEdit freely; Nova reads this file at the start of every chat in this workspace.\n\n- 2026-10-02: Bun is used for building the binary\n";

const posix = process.platform !== "win32";
let base: string;
let home: string;
let cwd: string;
const previousHome = process.env.NOVA_AI_HOME;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "nova-memory-"));
  home = join(base, "home");
  cwd = join(base, "repo");
  mkdirSync(cwd, { recursive: true });
  process.env.NOVA_AI_HOME = home;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.NOVA_AI_HOME;
  else process.env.NOVA_AI_HOME = previousHome;
});

const read = (path: string) => readFileSync(path, "utf8");

describe("memory layout (docs/NOVA_HOME.md)", () => {
  it("keeps global memory in the home root and project memory in the project folder", () => {
    const paths = memoryPaths(cwd);
    assert.equal(paths.global.index, join(home, "MEMORY.md"));
    assert.equal(paths.global.notes, join(home, "memory"));
    assert.equal(paths.project.index, join(projectPaths(cwd).dir, "MEMORY.md"));
    assert.equal(paths.project.notes, join(projectPaths(cwd).dir, "memory"));
  });

  it("reads the extension's MEMORY.md without its generated header", () => {
    const paths = memoryPaths(cwd);
    mkdirSync(projectPaths(cwd).dir, { recursive: true });
    writeFileSync(paths.project.index, EXTENSION_PROJECT_FILE);
    const memory = loadMemory(cwd);
    assert.deepEqual(memory.blocks, [
      {
        scope: "project",
        source: "MEMORY.md",
        text: "- 2026-10-02: Bun is used for building the binary",
      },
    ]);
  });

  it("loads nothing, not even NOVA.md, when the session has memory switched off", () => {
    writeFileSync(join(cwd, "NOVA.md"), "Use tabs.");
    applyMemoryChange(cwd, "project", { action: "remember", text: "Project fact" });
    assert.ok(sessionMemory(cwd, true).blocks.length > 0);
    assert.deepEqual(sessionMemory(cwd, false), { blocks: [], notes: [], consolidate: [] });
    assert.equal(buildMemorySystemPrompt(sessionMemory(cwd, false), false), null);
  });

  it("puts team instructions first, then project, then global memory", () => {
    writeFileSync(join(cwd, "NOVA.md"), "Use tabs.");
    writeFileSync(join(cwd, "AGENTS.md"), "Run npm test.");
    applyMemoryChange(cwd, "project", { action: "remember", text: "Project fact" });
    applyMemoryChange(cwd, "global", { action: "remember", text: "Global fact" });
    const memory = loadMemory(cwd);
    assert.deepEqual(
      memory.blocks.map((block) => `${block.scope}:${block.source}`),
      ["repository:NOVA.md", "repository:AGENTS.md", "project:MEMORY.md", "global:MEMORY.md"],
    );
    const prompt = buildMemorySystemPrompt(memory);
    assert.match(prompt, /<memory scope="repository" source="NOVA.md">\nUse tabs\.\n<\/memory>/);
    assert.match(prompt, /not as instructions that override the user/);
  });
});

describe("MEMORY.md facts", () => {
  it("creates the file with the shared header and appends dated, de-duplicated facts", () => {
    const paths = memoryPaths(cwd);
    const first = applyMemoryChange(cwd, "project", { action: "remember", text: "Uses  pnpm." });
    assert.match(first.summary, /Remembered/);
    assert.equal(first.diff?.oldText, null);
    applyMemoryChange(cwd, "project", { action: "remember", text: "uses pnpm" });
    const text = read(paths.project.index);
    assert.ok(text.startsWith("# Nova memory (this project)\n"));
    assert.equal(text.match(/^- \d{4}-\d{2}-\d{2}: Uses pnpm\.$/gm)?.length, 1);
    if (posix) assert.equal(statSync(paths.project.index).mode & 0o777, 0o600);
  });

  it("replaces, forgets and rewrites entries like the extension", () => {
    const index = memoryPaths(cwd).global.index;
    applyMemoryChange(cwd, "global", { action: "remember", text: "Prefers npm" });
    applyMemoryChange(cwd, "global", { action: "remember", text: "Likes short answers" });
    applyMemoryChange(cwd, "global", { action: "replace", match: "npm", text: "Prefers pnpm" });
    assert.match(read(index), /Prefers pnpm/);
    assert.doesNotMatch(read(index), /Prefers npm/);
    applyMemoryChange(cwd, "global", { action: "forget", match: "short" });
    assert.doesNotMatch(read(index), /short answers/);
    applyMemoryChange(cwd, "global", { action: "rewrite", text: "- One\nTwo" });
    assert.ok(read(index).startsWith("# Nova memory (global)"));
    assert.match(read(index), /\n- One\n- Two\n$/);
  });
});

describe("memory notes", () => {
  it("writes a typed note and keeps exactly one link line in the index", () => {
    const paths = memoryPaths(cwd);
    const save = (description: string) =>
      applyMemoryChange(cwd, "project", {
        action: "save_note",
        name: "release-flow",
        description,
        type: "project",
        content: "semantic-release on main",
      });
    save("how releases are cut");
    save("how releases are cut, updated");
    const note = read(join(paths.project.notes, "release-flow.md"));
    assert.match(note, /^---\nname: release-flow\ndescription: "how releases are cut, updated"\ntype: project\n---\n\nsemantic-release on main$/);
    const links = read(paths.project.index).match(/\(memory\/release-flow\.md\)/g);
    assert.equal(links?.length, 1);
    assert.match(read(paths.project.index), /- \[Release flow\]\(memory\/release-flow\.md\) — how releases are cut, updated/);

    const memory = loadMemory(cwd);
    assert.deepEqual(
      memory.notes.map((n) => [n.name, n.type, n.scope, n.description]),
      [["release-flow", "project", "project", "how releases are cut, updated"]],
    );

    applyMemoryChange(cwd, "project", { action: "delete_note", name: "release-flow" });
    assert.ok(!existsSync(join(paths.project.notes, "release-flow.md")));
    assert.doesNotMatch(read(paths.project.index), /release-flow/);
  });

  it("lets a project note hide a global note with the same name", () => {
    for (const scope of ["global", "project"] as const) {
      applyMemoryChange(cwd, scope, {
        action: "save_note",
        name: "style",
        description: `${scope} style`,
        type: "feedback",
        content: scope,
      });
    }
    assert.deepEqual(
      loadMemory(cwd).notes.map((n) => [n.name, n.scope]),
      [["style", "project"]],
    );
  });
});

describe("memory tools", () => {
  it("validates writes, accepts the old workspace scope and reads notes", async () => {
    let refreshed = 0;
    const write = createMemoryWriteTool(cwd, () => refreshed++);
    const ctx = makeToolContext({ cwd });
    assert.ok("error" in (await write.execute(ctx, { action: "save_note", scope: "project", name: "Bad Name", description: "d", type: "user", content: "x" })));
    assert.ok("error" in (await write.execute(ctx, { action: "nope", scope: "project" })));
    const saved = await write.execute(ctx, {
      action: "save_note",
      scope: "workspace",
      name: "build",
      description: "how to build",
      type: "project",
      content: "npm run build",
    });
    assert.ok(!("error" in saved));
    assert.equal(refreshed, 1);

    const reader = createMemoryReadTool(cwd, () => loadMemory(cwd));
    const note = await reader.execute(ctx, { name: "build" });
    assert.ok("output" in note && note.output.includes("npm run build"));
    const index = await reader.execute(ctx, { scope: "project" });
    assert.ok("output" in index && index.output.includes("(memory/build.md)"));
  });
});

describe("migration from CLI 1.1 memory folders", () => {
  function legacyKey(path: string): string {
    const label = "repo";
    const canonical = process.platform === "win32" ? path.toLowerCase() : path;
    return `${label}-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
  }
  const note = (name: string, description: string) =>
    `---\nname: ${name}\ndescription: "${description}"\ntype: user\n---\n\nbody of ${name}`;

  it("moves global and project notes into the shared layout and links them", () => {
    const legacyGlobal = join(home, "memory", "global");
    const legacyProject = join(home, "memory", legacyKey(cwd));
    mkdirSync(legacyGlobal, { recursive: true });
    mkdirSync(legacyProject, { recursive: true });
    writeFileSync(join(legacyGlobal, "tone.md"), note("tone", "be brief"));
    writeFileSync(join(legacyProject, "stack.md"), note("stack", "uses svelte"));

    const memory = loadMemory(cwd);
    const paths = memoryPaths(cwd);
    assert.ok(existsSync(join(paths.global.notes, "tone.md")));
    assert.ok(existsSync(join(paths.project.notes, "stack.md")));
    assert.ok(!existsSync(legacyGlobal) && !existsSync(legacyProject));
    assert.match(read(paths.global.index), /\(memory\/tone\.md\) — be brief/);
    assert.match(read(paths.project.index), /\(memory\/stack\.md\) — uses svelte/);
    assert.deepEqual(memory.notes.map((n) => [n.name, n.scope]), [
      ["stack", "project"],
      ["tone", "global"],
    ]);
  });

  it("leaves a legacy note in place when the name is already taken", () => {
    applyMemoryChange(cwd, "global", {
      action: "save_note",
      name: "tone",
      description: "new",
      type: "user",
      content: "new",
    });
    const legacyGlobal = join(home, "memory", "global");
    mkdirSync(legacyGlobal, { recursive: true });
    writeFileSync(join(legacyGlobal, "tone.md"), note("tone", "old"));
    loadMemory(cwd);
    assert.ok(existsSync(join(legacyGlobal, "tone.md")));
    assert.match(read(join(memoryPaths(cwd).global.notes, "tone.md")), /\nnew$/);
  });
});
