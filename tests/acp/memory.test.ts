import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildMemorySystemPrompt,
  createLoadMemoryTool,
  createSaveMemoryTool,
  discoverMemories,
  workspaceKey,
} from "../../src/acp/memory.js";
import type { ToolContext } from "../../src/acp/tools/types.js";

function writeMemory(
  dir: string,
  fileName: string,
  frontmatter: string,
  body = "body",
) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), `---\n${frontmatter}\n---\n${body}`);
}

test("memories are discovered from global and workspace tiers with workspace precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "nova-memory-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  try {
    const globalDir = join(home, ".nova-ai", "memory", "global");
    const workspaceDir = join(home, ".nova-ai", "memory", workspaceKey(cwd));

    writeMemory(
      globalDir,
      "no-coauthor.md",
      "name: no-coauthor\ndescription: Global note.\ntype: feedback",
    );
    writeMemory(
      workspaceDir,
      "no-coauthor.md",
      "name: no-coauthor\ndescription: Workspace override.\ntype: feedback",
    );
    writeMemory(
      workspaceDir,
      "project-fact.md",
      "name: project-fact\ndescription: Uses pnpm.\ntype: project",
    );

    const memories = discoverMemories(cwd, home);
    assert.deepEqual(
      memories.map((m) => m.name),
      ["no-coauthor", "project-fact"],
    );
    const overridden = memories.find((m) => m.name === "no-coauthor");
    assert.equal(overridden?.scope, "workspace");
    assert.match(overridden?.description ?? "", /Workspace override/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createLoadMemoryTool returns full note content for a known name", async () => {
  const root = mkdtempSync(join(tmpdir(), "nova-memory-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  try {
    const workspaceDir = join(home, ".nova-ai", "memory", workspaceKey(cwd));
    writeMemory(
      workspaceDir,
      "fact.md",
      "name: fact\ndescription: A fact.\ntype: project",
      "The build uses tsup.",
    );
    const memories = discoverMemories(cwd, home);
    const tool = createLoadMemoryTool(memories);

    const loaded = await tool.execute({} as ToolContext, { name: "fact" });
    assert.ok("output" in loaded);
    if ("output" in loaded) assert.match(loaded.output, /The build uses tsup/);

    const missing = await tool.execute({} as ToolContext, { name: "unknown" });
    assert.ok("error" in missing);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createSaveMemoryTool writes a well-formed frontmatter file and rejects unsafe names", async () => {
  const root = mkdtempSync(join(tmpdir(), "nova-memory-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  try {
    const tool = createSaveMemoryTool(cwd, home);

    const result = await tool.execute({} as ToolContext, {
      name: "prefers-terse-prs",
      description: "User wants terse PR descriptions.",
      type: "feedback",
      scope: "workspace",
      content: "Keep PR descriptions to two bullets.",
    });
    assert.ok("output" in result);

    const written = readFileSync(
      join(home, ".nova-ai", "memory", workspaceKey(cwd), "prefers-terse-prs.md"),
      "utf8",
    );
    assert.match(written, /name: prefers-terse-prs/);
    assert.match(written, /description: "User wants terse PR descriptions\."/);
    assert.match(written, /type: feedback/);
    assert.match(written, /Keep PR descriptions to two bullets\./);

    const badName = await tool.execute({} as ToolContext, {
      name: "../escape",
      description: "x",
      type: "feedback",
      scope: "workspace",
      content: "x",
    });
    assert.ok("error" in badName);

    const injectedDescription = await tool.execute({} as ToolContext, {
      name: "safe-name",
      description: "safe\ntype: reference",
      type: "feedback",
      scope: "workspace",
      content: "x",
    });
    assert.ok("error" in injectedDescription);

    const badType = await tool.execute({} as ToolContext, {
      name: "ok-name",
      description: "x",
      type: "not-a-type",
      scope: "workspace",
      content: "x",
    });
    assert.ok("error" in badType);

    const updated = await tool.execute({} as ToolContext, {
      name: "prefers-terse-prs",
      description: "User wants terse PR descriptions.",
      type: "feedback",
      scope: "workspace",
      content: "Use one bullet when possible.",
    });
    assert.ok("output" in updated);
    assert.match(
      readFileSync(
        join(
          home,
          ".nova-ai",
          "memory",
          workspaceKey(cwd),
          "prefers-terse-prs.md",
        ),
        "utf8",
      ),
      /Use one bullet when possible\./,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a saved memory is immediately available to the current tool set", async () => {
  const root = mkdtempSync(join(tmpdir(), "nova-memory-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  let memories = discoverMemories(cwd, home);
  const load = createLoadMemoryTool(() => memories);
  const save = createSaveMemoryTool(cwd, home, () => {
    memories = discoverMemories(cwd, home);
  });

  try {
    const saved = await save.execute({} as ToolContext, {
      name: "build-system",
      description: "Project build system.",
      type: "project",
      scope: "workspace",
      content: "The build uses tsup.",
    });
    assert.ok("output" in saved);

    const loaded = await load.execute({} as ToolContext, {
      name: "build-system",
    });
    assert.ok("output" in loaded);
    if ("output" in loaded) assert.match(loaded.output, /The build uses tsup\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory catalog instructs the model when to save and load notes", () => {
  const prompt = buildMemorySystemPrompt([
    {
      name: "no-coauthor",
      description: "Never add a co-author trailer.",
      type: "feedback",
      path: "/memory/global/no-coauthor.md",
      scope: "global",
    },
  ]);
  assert.match(prompt ?? "", /Call save_memory when/);
  assert.match(
    prompt ?? "",
    /no-coauthor \[feedback\/global\]: Never add a co-author trailer\./,
  );
  assert.match(prompt ?? "", /Never save secrets/);
});

test("memory policy remains active before the first note is saved", () => {
  const prompt = buildMemorySystemPrompt([]);
  assert.match(prompt ?? "", /None saved yet/);
  assert.match(prompt ?? "", /Default to workspace scope/);
});
