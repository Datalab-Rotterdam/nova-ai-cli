import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectPaths } from "../../src/core/nova-home.js";
import {
  buildSkillsSystemPrompt,
  createLoadSkillTool,
  disabledSkillNames,
  discoverSkills,
  rankSkills,
  setSkillEnabled,
} from "../../src/core/skills.js";
import type { ToolContext } from "../../src/core/tools/types.js";

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
  assert.match(prompt ?? "", /^- review: Review code\.$/m);
});

test("Nova's own skill folders win over the shared ones, and disabled skills are left out", () => {
  const root = mkdtempSync(join(tmpdir(), "nova-skills-"));
  const home = join(root, "home");
  const novaHome = join(root, "nova-home");
  const cwd = join(root, "workspace");
  const previousHome = process.env.NOVA_AI_HOME;
  process.env.NOVA_AI_HOME = novaHome;
  const skill = (dir: string, name: string, description: string) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody`);
  };
  try {
    skill(join(home, ".claude", "skills"), "review", "Claude review.");
    skill(join(novaHome, "skills"), "review", "Nova global review.");
    skill(join(novaHome, "skills"), "release", "Cut a release.");
    skill(join(cwd, ".agents", "skills"), "deploy", "Shared deploy.");
    skill(join(cwd, ".nova-ai", "skills"), "deploy", "Nova project deploy.");

    const skills = discoverSkills(cwd, home, novaHome);
    assert.deepEqual(
      skills.map((entry) => [entry.name, entry.description, entry.source]),
      [
        ["deploy", "Nova project deploy.", "workspace"],
        ["release", "Cut a release.", "user"],
        ["review", "Nova global review.", "user"],
      ],
    );

    writeFileSync(join(novaHome, "settings.json"), JSON.stringify({ skills: { disabled: ["release"] } }));
    mkdirSync(projectPaths(cwd).dir, { recursive: true });
    writeFileSync(projectPaths(cwd).settings, JSON.stringify({ permissions: {}, skills: { disabled: ["deploy"] } }));
    assert.deepEqual([...disabledSkillNames(cwd, novaHome)].sort(), ["deploy", "release"]);
  } finally {
    if (previousHome === undefined) delete process.env.NOVA_AI_HOME;
    else process.env.NOVA_AI_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the skill list stays within its budget and keeps matching skills described", () => {
  const skills = Array.from({ length: 80 }, (_, index) => ({
    name: `skill-${String(index).padStart(2, "0")}`,
    description: `Does task number ${index} ${"with a long explanation ".repeat(10)}`,
    path: "",
    root: "",
    source: "user" as const,
  }));
  skills.push({ name: "deploy-kubernetes", description: "Roll out to the cluster.", path: "", root: "", source: "user" });

  const prompt = buildSkillsSystemPrompt(skills, "Please deploy this to kubernetes")!;
  assert.ok(prompt.length < 6_000, `prompt is ${prompt.length} characters`);
  assert.match(prompt, /^- deploy-kubernetes: Roll out to the cluster\.$/m, "the matching skill keeps its description");
  assert.match(prompt, /More skills \(load by name when one fits\): .*skill-\d\d/);
  assert.ok(prompt.split("\n").every((line) => line.length <= 1_100));
  assert.ok(
    prompt.split("\n").filter((line) => line.startsWith("- ")).every((line) => line.length <= "- skill-00: ".length + 160),
    "descriptions are clipped",
  );

  // A short list is shown whole, in name order, regardless of the message.
  const few = buildSkillsSystemPrompt(skills.slice(0, 3), "anything")!;
  assert.deepEqual(few.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.split(":")[0]), ["- skill-00", "- skill-01", "- skill-02"]);
  assert.equal(buildSkillsSystemPrompt([]), null);
});

test("rankSkills puts name matches before description matches", () => {
  const make = (name: string, description: string) => ({ name, description, path: "", root: "", source: "user" as const });
  const ranked = rankSkills([make("alpha", "nothing to do with it"), make("changelog", "for every release"), make("release", "cut it")], "prepare the release");
  assert.deepEqual(ranked.map((skill) => skill.name), ["release", "changelog", "alpha"]);
  assert.deepEqual(rankSkills([make("b", "x"), make("a", "y")], "").map((skill) => skill.name), ["a", "b"], "no match: by name");
});

test("skills are switched on and off per scope without touching other settings", () => {
  const root = mkdtempSync(join(tmpdir(), "nova-skills-"));
  const novaHome = join(root, "nova-home");
  const cwd = join(root, "workspace");
  const previousHome = process.env.NOVA_AI_HOME;
  process.env.NOVA_AI_HOME = novaHome;
  try {
    mkdirSync(novaHome, { recursive: true });
    writeFileSync(join(novaHome, "settings.json"), JSON.stringify({ permissions: { allow: ["run_command(npm test)"] } }));
    setSkillEnabled(cwd, "global", "review", false, novaHome);
    setSkillEnabled(cwd, "global", "review", false, novaHome);
    setSkillEnabled(cwd, "project", "deploy", false, novaHome);
    assert.deepEqual([...disabledSkillNames(cwd, novaHome)].sort(), ["deploy", "review"]);
    assert.deepEqual(JSON.parse(readFileSync(join(novaHome, "settings.json"), "utf8")), {
      permissions: { allow: ["run_command(npm test)"] },
      skills: { disabled: ["review"] },
    });

    setSkillEnabled(cwd, "global", "review", true, novaHome);
    assert.deepEqual([...disabledSkillNames(cwd, novaHome)], ["deploy"]);
  } finally {
    if (previousHome === undefined) delete process.env.NOVA_AI_HOME;
    else process.env.NOVA_AI_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
