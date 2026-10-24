import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { scalar, splitFrontmatter } from "./agent-files.js";
import { novaHomeRoot } from "./nova-home.js";

/**
 * Slash commands written as markdown files, in Claude Code's format
 * (docs/NOVA_HOME.md, "Commands"): the file's text is the prompt, `$ARGUMENTS`
 * (or `$1`…`$9`) what the user typed after the command. Folders, a later one
 * replacing a command of the same name: `~/.claude/commands`,
 * `~/.nova-ai/commands`, then the workspace's `.claude/commands` and
 * `.nova-ai/commands`. A file in a subfolder is named `folder:name`. Same
 * format as the VS Code extension.
 */
export type CommandFile = {
  name: string;
  description: string;
  argumentHint?: string;
  /** A model id for this command's answer instead of the session's model. */
  model?: string;
  prompt: string;
  path: string;
};

export function listCommandFiles(cwd: string, home = homedir(), novaHome = novaHomeRoot()): CommandFile[] {
  const byName = new Map<string, CommandFile>();
  const roots = [
    join(home, ".claude", "commands"),
    join(novaHome, "commands"),
    join(cwd, ".claude", "commands"),
    join(cwd, ".nova-ai", "commands"),
  ];
  for (const root of roots) {
    for (const path of markdownFiles(root)) {
      const name = relative(root, path).replace(/\.md$/i, "").split(sep).join(":").toLowerCase();
      if (!/^[a-z0-9][\w:-]*$/.test(name)) continue;
      let content: string;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const { frontmatter, body } = splitFrontmatter(content);
      const hint = scalar(frontmatter, "argument-hint");
      const model = scalar(frontmatter, "model");
      byName.set(name, {
        name,
        description: scalar(frontmatter, "description") || firstLine(body) || `Run ${name}`,
        ...(hint ? { argumentHint: hint } : {}),
        ...(model ? { model } : {}),
        prompt: body,
        path,
      });
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The command's prompt with what the user typed: `$ARGUMENTS` for all of it,
 * `$1`…`$9` for single words; without placeholders the arguments are added
 * after a blank line.
 */
export function expandCommand(command: Pick<CommandFile, "prompt">, args: string): string {
  const words = args.split(/\s+/).filter(Boolean);
  const uses = /\$ARGUMENTS|\$[1-9]/.test(command.prompt);
  const expanded = command.prompt
    .replace(/\$ARGUMENTS/g, () => args)
    .replace(/\$([1-9])/g, (_, index: string) => words[Number(index) - 1] ?? "");
  return uses || !args ? expanded : `${expanded}\n\n${args}`;
}

function markdownFiles(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) return markdownFiles(path);
    return entry.isFile() && entry.name.toLowerCase().endsWith(".md") ? [path] : [];
  });
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 80) ?? "";
}
