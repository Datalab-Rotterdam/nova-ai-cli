import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSkillsSystemPrompt, createLoadSkillTool, discoverSkills } from "../../src/acp/skills.js";
import type { ToolContext } from "../../src/acp/tools/types.js";

test("skills are discovered from user and workspace roots with workspace precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "nova-skills-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  try {
    const userSkill = join(home, ".agents", "skills", "review");
    const workspaceSkill = join(cwd, ".agents", "skills", "review");
    const nestedSkill = join(home, ".agents", "skills", "cloud", "deploy");
    mkdirSync(userSkill, { recursive: true });
    mkdirSync(workspaceSkill, { recursive: true });
    mkdirSync(nestedSkill, { recursive: true });
    writeFileSync(join(userSkill, "SKILL.md"), "---\nname: review\ndescription: User review.\n---\nuser");
    writeFileSync(join(workspaceSkill, "SKILL.md"), "---\nname: review\ndescription: Workspace review.\n---\nworkspace");
    writeFileSync(join(nestedSkill, "SKILL.md"), "---\nname: deploy\ndescription: Deploy safely.\n---\ndeploy");

    const skills = discoverSkills(cwd, home);
    assert.deepEqual(skills.map((skill) => skill.name), ["deploy", "review"]);
    assert.equal(skills.find((skill) => skill.name === "review")?.source, "workspace");
    assert.match(skills.find((skill) => skill.name === "review")?.description ?? "", /Workspace review/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("load_skill reads instructions and contained resources but blocks traversal", async () => {
  const root = mkdtempSync(join(tmpdir(), "nova-skills-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  try {
    const skillRoot = join(cwd, ".agents", "skills", "review");
    mkdirSync(join(skillRoot, "references"), { recursive: true });
    writeFileSync(join(skillRoot, "SKILL.md"), "---\nname: review\ndescription: Review code.\n---\n# Instructions");
    writeFileSync(join(skillRoot, "references", "rules.md"), "Keep boundaries clear.");
    const skills = discoverSkills(cwd, home);
    const tool = createLoadSkillTool(skills);

    const loaded = await tool.execute({} as ToolContext, { name: "review" });
    assert.ok("output" in loaded);
    if ("output" in loaded) assert.match(loaded.output, /# Instructions/);

    const resource = await tool.execute({} as ToolContext, { name: "review", resource: "references/rules.md" });
    assert.ok("output" in resource);
    if ("output" in resource) assert.match(resource.output, /Keep boundaries clear/);

    const escaped = await tool.execute({} as ToolContext, { name: "review", resource: "../secret.md" });
    assert.ok("error" in escaped);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill catalog instructs the model to load matching skills progressively", () => {
  const prompt = buildSkillsSystemPrompt([{
    name: "review",
    description: "Review code.",
    path: "/skills/review/SKILL.md",
    root: "/skills/review",
    source: "user",
  }]);
  assert.match(prompt ?? "", /call load_skill before acting/);
  assert.match(prompt ?? "", /review \[user\]: Review code/);
});
