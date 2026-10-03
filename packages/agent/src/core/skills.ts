import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "./tools/types.js";

export type SkillDefinition = {
  name: string;
  description: string;
  path: string;
  root: string;
  source: "user" | "workspace";
};

export function discoverSkills(cwd: string, home = homedir()): SkillDefinition[] {
  const roots: Array<{ path: string; source: SkillDefinition["source"] }> = [
    { path: join(home, ".agents", "skills"), source: "user" },
    { path: join(home, ".claude", "skills"), source: "user" },
    { path: join(home, ".codex", "skills"), source: "user" },
    { path: join(cwd, ".agents", "skills"), source: "workspace" },
    { path: join(cwd, ".claude", "skills"), source: "workspace" },
    { path: join(cwd, ".codex", "skills"), source: "workspace" },
  ];
  const skills = new Map<string, SkillDefinition>();

  for (const root of roots) {
    for (const path of findSkillFiles(root.path)) {
      const metadata = readSkillMetadata(path);
      if (!metadata) continue;
      // Later roots have higher priority, so workspace skills override a user
      // skill with the same name.
      skills.set(metadata.name, {
        ...metadata,
        path,
        root: dirname(path),
        source: root.source,
      });
    }
  }

  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function buildSkillsSystemPrompt(skills: SkillDefinition[]): string | null {
  if (skills.length === 0) return null;
  return [
    "Skills provide specialized workflows through progressive disclosure.",
    "When the user explicitly names a skill or the task clearly matches one, call load_skill before acting and follow the returned instructions.",
    "Use load_skill again with a relative resource path when the SKILL.md references another file. Do not claim a skill was loaded until the tool succeeds.",
    "Available skills:",
    ...skills.map((skill) => `- ${skill.name} [${skill.source}]: ${skill.description}`),
  ].join("\n");
}

export function createLoadSkillTool(skills: SkillDefinition[]): ToolDefinition {
  const catalog = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    name: "load_skill",
    description: "load a discovered skill instruction or one of its referenced resources.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "skill name" },
        resource: { type: "string", description: "optional relative file, defaults to SKILL.md" },
      },
      required: ["name"],
    },
    mutating: false,
    kind: "read",
    async execute(_context, args) {
      const name = typeof args.name === "string" ? args.name : "";
      const resource = typeof args.resource === "string" && args.resource ? args.resource : "SKILL.md";
      const skill = catalog.get(name);
      if (!skill) return { error: `Unknown skill: ${name || "(missing name)"}.` };

      const target = resolve(skill.root, resource);
      const relativePath = relative(skill.root, target);
      if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        return { error: `Skill resource must stay inside ${skill.root}.` };
      }
      try {
        const content = await readFile(target, "utf8");
        return {
          output: `Skill: ${skill.name}\nSkill root: ${skill.root}\nResource: ${relativePath || basename(target)}\n\n${content}`,
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : `Could not load ${target}.` };
      }
    },
  };
}

function findSkillFiles(root: string, max = 500): string[] {
  const files: string[] = [];
  const stack = [root];
  let visited = 0;
  while (stack.length > 0 && visited < max) {
    const directory = stack.pop()!;
    visited++;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name === "SKILL.md") files.push(path);
    }
  }
  return files;
}

function readSkillMetadata(path: string): Pick<SkillDefinition, "name" | "description"> | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
  const name = readFrontmatterValue(frontmatter, "name") || basename(dirname(path));
  const description = readFrontmatterValue(frontmatter, "description") || "No description provided.";
  return { name, description };
}

function readFrontmatterValue(frontmatter: string, key: string): string {
  const raw = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]?.trim() ?? "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).replace(/\\"/g, '"');
  }
  return raw;
}
