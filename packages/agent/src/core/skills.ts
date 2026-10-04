import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { novaHomeRoot, projectPaths, writePrivateFile } from "./nova-home.js";
import { readSettings } from "./policy/settings.js";
import type { ToolDefinition } from "./tools/types.js";

export type SkillDefinition = {
  name: string;
  description: string;
  path: string;
  root: string;
  source: "user" | "workspace";
};

/**
 * Skill folders, lowest priority first (docs/NOVA_HOME.md, "Skills"): the
 * shared .agents/.claude/.codex folders, then Nova's own, in the home folder
 * and then in the workspace. A skill with the same name in a later folder
 * replaces the earlier one.
 */
export function skillRoots(
  cwd: string,
  home = homedir(),
  novaHome = novaHomeRoot(),
): Array<{ path: string; source: SkillDefinition["source"] }> {
  return [
    { path: join(home, ".agents", "skills"), source: "user" },
    { path: join(home, ".claude", "skills"), source: "user" },
    { path: join(home, ".codex", "skills"), source: "user" },
    { path: join(novaHome, "skills"), source: "user" },
    { path: join(cwd, ".agents", "skills"), source: "workspace" },
    { path: join(cwd, ".claude", "skills"), source: "workspace" },
    { path: join(cwd, ".codex", "skills"), source: "workspace" },
    { path: join(cwd, ".nova-ai", "skills"), source: "workspace" },
  ];
}

/**
 * Names switched off in `skills.disabled` of the user's settings (everywhere)
 * or of the project's private settings (this workspace only).
 */
export function disabledSkillNames(cwd: string, novaHome = novaHomeRoot()): Set<string> {
  const names = new Set<string>();
  for (const path of [join(novaHome, "settings.json"), projectPaths(cwd).settings]) {
    const skills = readSettings(path)?.skills;
    const disabled = skills && typeof skills === "object" ? (skills as { disabled?: unknown }).disabled : undefined;
    if (Array.isArray(disabled)) {
      for (const name of disabled) if (typeof name === "string") names.add(name);
    }
  }
  return names;
}

/**
 * Switches a skill on or off by name: `global` in the user's settings (every
 * workspace), `project` in this workspace's private settings. Other keys of
 * the file are kept. Returns the file written.
 */
export function setSkillEnabled(
  cwd: string,
  scope: "global" | "project",
  name: string,
  enabled: boolean,
  novaHome = novaHomeRoot(),
): string {
  const path = scope === "global" ? join(novaHome, "settings.json") : projectPaths(cwd).settings;
  const settings = readSettings(path) ?? {};
  const skills = settings.skills && typeof settings.skills === "object" && !Array.isArray(settings.skills)
    ? (settings.skills as Record<string, unknown>)
    : {};
  const disabled = Array.isArray(skills.disabled)
    ? skills.disabled.filter((entry): entry is string => typeof entry === "string" && entry !== name)
    : [];
  if (!enabled) disabled.push(name);
  writePrivateFile(path, `${JSON.stringify({ ...settings, skills: { ...skills, disabled } }, null, 2)}\n`);
  return path;
}

/** The skills a session may use: discovered and not switched off. */
export function discoverEnabledSkills(cwd: string): SkillDefinition[] {
  const disabled = disabledSkillNames(cwd);
  return discoverSkills(cwd).filter((skill) => !disabled.has(skill.name));
}

export function discoverSkills(cwd: string, home = homedir(), novaHome = novaHomeRoot()): SkillDefinition[] {
  const roots = skillRoots(cwd, home, novaHome);
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

/** Room the skill list may take in every request (characters, about 1k tokens). */
const CATALOG_CHARS = 4_000;
/** Room for the names of skills that did not fit with their description. */
const NAMES_CHARS = 1_000;
const DESCRIPTION_CHARS = 160;
/** Most of one skill file returned by load_skill. */
const MAX_SKILL_CHARS = 24_000;

/**
 * The skill list for the system prompt. Only names and one-line descriptions:
 * a skill's instructions are read with load_skill when needed. The list has a
 * fixed budget; when there are more skills than fit, the ones matching the
 * user's message (`query`) keep their description, the others are listed by
 * name, and what still does not fit is counted.
 */
export function buildSkillsSystemPrompt(skills: SkillDefinition[], query = ""): string | null {
  if (skills.length === 0) return null;
  const entry = (skill: SkillDefinition) => `- ${skill.name}: ${clip(oneLine(skill.description), DESCRIPTION_CHARS)}`;
  const all = skills.map(entry);
  const lines: string[] = [];
  const names: string[] = [];
  let more = 0;
  if (all.join("\n").length <= CATALOG_CHARS) {
    lines.push(...all);
  } else {
    let used = 0;
    let namesUsed = 0;
    for (const skill of rankSkills(skills, query)) {
      const line = entry(skill);
      if (used + line.length + 1 <= CATALOG_CHARS) {
        lines.push(line);
        used += line.length + 1;
      } else if (namesUsed + skill.name.length + 2 <= NAMES_CHARS) {
        names.push(skill.name);
        namesUsed += skill.name.length + 2;
      } else {
        more++;
      }
    }
  }
  return [
    "Skills provide specialized workflows through progressive disclosure.",
    "When the user explicitly names a skill or the task clearly matches one, call load_skill before acting and follow the returned instructions.",
    "Use load_skill again with a relative resource path when the SKILL.md references another file. Do not claim a skill was loaded until the tool succeeds.",
    "Available skills:",
    ...lines,
    ...(names.length ? [`More skills (load by name when one fits): ${names.join(", ")}${more ? `, and ${more} more` : ""}.`] : []),
  ].join("\n");
}

/** Skills matching more words of the query first (name matches count most), then by name. */
export function rankSkills(skills: readonly SkillDefinition[], query: string): SkillDefinition[] {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  const score = (skill: SkillDefinition) => {
    const name = skill.name.toLowerCase();
    const description = skill.description.toLowerCase();
    return words.reduce((total, word) => total + (name.includes(word) ? 3 : 0) + (description.includes(word) ? 1 : 0), 0);
  };
  return skills
    .map((skill) => ({ skill, score: score(skill) }))
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
    .map(({ skill }) => skill);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
        const cut = content.length > MAX_SKILL_CHARS;
        return {
          output: `Skill: ${skill.name}\nSkill root: ${skill.root}\nResource: ${relativePath || basename(target)}\n\n${cut ? content.slice(0, MAX_SKILL_CHARS) : content}${cut ? `\n\n[Cut at ${MAX_SKILL_CHARS} of ${content.length} characters.]` : ""}`,
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
