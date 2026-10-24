import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INTERACTION_MODES } from "./interaction-modes.js";
import { novaHomeRoot, projectPaths } from "./nova-home.js";

/**
 * The user's own agents (docs/NOVA_HOME.md, "Agents"): `<name>.agent.md` in
 * ~/.nova-ai/agents (every project) and ~/.nova-ai/projects/<key>/agents
 * (this project, replacing a global one with the same id). The frontmatter
 * names the agent and narrows its tools; the body is added to the system
 * prompt. Each one is offered as an extra session mode next to the built-in
 * ones, whose ids it cannot take. Same format as the VS Code extension.
 */
export type AgentFile = {
  id: string;
  name: string;
  description: string;
  /** System prompt addition (the markdown body). */
  prompt: string;
  /** Tool names (groups expanded) the agent may use; undefined means all of them. */
  tools?: string[];
  /** Only tools that change nothing. */
  readOnly: boolean;
  source: "global" | "project";
  path: string;
};

/** Groups a `tools:` entry may name; VS Code's tool names are accepted too (TOOL_ALIASES). */
export const TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  read: ["read_file", "list_directory", "find_files", "search_text", "inspect_environment"],
  search: ["list_directory", "find_files", "search_text"],
  edit: ["edit_file", "write_file"],
  run: ["run_command", "run_package_script", "start_background_command", "list_background_jobs", "read_background_output", "wait_for_background_jobs", "kill_background_job", "release_background_job"],
  web: ["fetch_url", "web_search"],
  memory: ["memory_read", "memory_write"],
  ask: ["ask_user"],
  todo: ["update_plan"],
  skills: ["load_skill"],
  subagents: ["start_background_agent", "list_background_jobs", "read_background_output", "wait_for_background_jobs", "kill_background_job", "release_background_job"],
};

/** The VS Code extension's names for the same tools, so one agent file works in both. */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  list_dir: "list_directory",
  create_file: "write_file",
  todo_write: "update_plan",
  spawn_agents: "start_background_agent",
};

/** The id a file name gives (`Code Review.agent.md` → `code-review`). */
export function agentIdOf(fileName: string): string {
  return fileName
    .replace(/\.agent\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The user's agents for `cwd`, by name; project agents replace global ones. */
export function listAgentFiles(cwd: string, novaHome = novaHomeRoot()): AgentFile[] {
  const byId = new Map<string, AgentFile>();
  const dirs: Array<[string, AgentFile["source"]]> = [
    [join(novaHome, "agents"), "global"],
    [join(projectPaths(cwd).dir, "agents"), "project"],
  ];
  for (const [dir, source] of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".agent.md")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      let content: string;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const agent = parseAgentFile(content, name, source, path);
      if (agent) byId.set(agent.id, agent);
    }
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function findAgentFile(cwd: string, id: string): AgentFile | undefined {
  return listAgentFiles(cwd).find((agent) => agent.id === id);
}

export function parseAgentFile(
  content: string,
  fileName: string,
  source: AgentFile["source"],
  path: string,
): AgentFile | undefined {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(content);
  const frontmatter = match?.[1] ?? "";
  const id = agentIdOf(fileName);
  // A built-in mode cannot be replaced; helpers (`user-invocable: false`) are not modes.
  if (!id || (INTERACTION_MODES as readonly string[]).includes(id) || scalar(frontmatter, "user-invocable") === "false") {
    return undefined;
  }
  const tools = listValue(frontmatter, "tools");
  return {
    id,
    name: scalar(frontmatter, "name") || id,
    description: scalar(frontmatter, "description") || "No description provided.",
    prompt: (match ? match[2]! : content).trim(),
    ...(tools ? { tools: [...new Set(tools.flatMap((entry) => TOOL_GROUPS[entry] ?? [TOOL_ALIASES[entry] ?? entry]))] } : {}),
    readOnly: scalar(frontmatter, "readOnly") === "true",
    source,
    path,
  };
}

function scalar(frontmatter: string, key: string): string {
  const raw = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(frontmatter)?.[1]?.trim() ?? "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).replace(/\\"/g, '"');
  }
  return raw;
}

/** `key: [a, "b"]` on one line, or a block of `- a` lines. */
function listValue(frontmatter: string, key: string): string[] | undefined {
  const inline = new RegExp(`^${key}:[ \\t]*\\[([\\s\\S]*?)\\]`, "m").exec(frontmatter)?.[1];
  const block = new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]+-[^\\n]*\\n?)+)`, "m").exec(frontmatter)?.[1];
  const raw = inline ?? block?.replace(/^\s*-\s*/gm, ",");
  if (raw === undefined) return undefined;
  return raw.split(",").map((entry) => entry.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}
