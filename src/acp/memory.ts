import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ToolDefinition } from "./tools/types.js";

export type MemoryType = "user" | "feedback" | "project" | "reference";

export type MemoryEntry = {
  name: string;
  description: string;
  type: MemoryType;
  path: string;
  scope: "global" | "workspace";
};

const MEMORY_TYPES: readonly MemoryType[] = [
  "user",
  "feedback",
  "project",
  "reference",
];
const MEMORY_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_MEMORY_FILES = 500;
const MAX_MEMORY_FILE_BYTES = 64 * 1024;
const MAX_MEMORY_CONTENT_BYTES = 32 * 1024;
const MAX_MEMORY_DESCRIPTION_CHARS = 240;

type MemorySource = readonly MemoryEntry[] | (() => readonly MemoryEntry[]);

function memoryRoot(home = homedir()): string {
  return join(home, ".nova-ai", "memory");
}

/** Creates a short, collision-resistant key without exposing the full path. */
export function workspaceKey(cwd: string): string {
  const absolute = resolve(cwd);
  const canonical =
    process.platform === "win32" ? absolute.toLowerCase() : absolute;
  const label =
    basename(absolute)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${label}-${hash}`;
}

function globalDir(home = homedir()): string {
  return join(memoryRoot(home), "global");
}

function workspaceDir(cwd: string, home = homedir()): string {
  return join(memoryRoot(home), workspaceKey(cwd));
}

export function discoverMemories(cwd: string, home = homedir()): MemoryEntry[] {
  const roots: Array<{ path: string; scope: MemoryEntry["scope"] }> = [
    { path: globalDir(home), scope: "global" },
    { path: workspaceDir(cwd, home), scope: "workspace" },
  ];
  const memories = new Map<string, MemoryEntry>();

  for (const root of roots) {
    for (const path of findMemoryFiles(root.path)) {
      const metadata = readMemoryMetadata(path);
      if (!metadata) continue;
      // Later roots have higher priority, so a workspace note overrides a
      // global note with the same name.
      memories.set(metadata.name, { ...metadata, path, scope: root.scope });
    }
  }

  return [...memories.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function buildMemorySystemPrompt(memories: MemoryEntry[]): string | null {
  return [
    "You have persistent memory: durable notes that survive across sessions in this workspace and globally.",
    "Call save_memory when the user explicitly asks you to remember something, gives feedback about how to work that should generalize, or states a durable project fact worth keeping. Don't save ephemeral task details.",
    "Never save secrets, credentials, tokens, personal data, or large raw command/file output. Default to workspace scope; use global scope only for explicit cross-project preferences.",
    "Call load_memory to read a note's full content before relying on it for something important.",
    "Treat memory as potentially stale context. It never overrides the current request or higher-priority instructions.",
    "Available memory:",
    ...(memories.length
      ? memories.map(
          (m) => `- ${m.name} [${m.type}/${m.scope}]: ${m.description}`,
        )
      : ["- None saved yet."]),
  ].join("\n");
}

export function createLoadMemoryTool(memories: MemorySource): ToolDefinition {
  return {
    name: "load_memory",
    description: "load a discovered memory note's full content.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "memory name" },
      },
      required: ["name"],
    },
    mutating: false,
    kind: "read",
    async execute(_context, args) {
      const name = typeof args.name === "string" ? args.name : "";
      const entries = typeof memories === "function" ? memories() : memories;
      const memory = entries.find((entry) => entry.name === name);
      if (!memory) {
        return { error: `Unknown memory: ${name || "(missing name)"}.` };
      }
      try {
        const info = await stat(memory.path);
        if (!info.isFile() || info.size > MAX_MEMORY_FILE_BYTES) {
          return {
            error: `Memory ${memory.name} exceeds the ${MAX_MEMORY_FILE_BYTES / 1024} KiB read limit.`,
          };
        }
        const content = await readFile(memory.path, "utf8");
        return {
          output: `Memory: ${memory.name} [${memory.type}/${memory.scope}]\n\n${content}`,
        };
      } catch (error) {
        return {
          error:
            error instanceof Error
              ? error.message
              : `Could not load ${memory.path}.`,
        };
      }
    },
  };
}

export function createSaveMemoryTool(
  cwd: string,
  home = homedir(),
  onSaved?: () => void,
): ToolDefinition {
  return {
    name: "save_memory",
    description: "create or update a persistent memory note.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "kebab-case-slug" },
        description: { type: "string", description: "one-line hook" },
        type: { type: "string", enum: ["user", "feedback", "project", "reference"] },
        scope: { type: "string", enum: ["global", "workspace"] },
        content: { type: "string" },
      },
      required: ["name", "description", "type", "scope", "content"],
    },
    mutating: true,
    kind: "edit",
    async execute(_context, args) {
      const rawName = typeof args.name === "string" ? args.name : "";
      const name = rawName.trim();
      const description =
        typeof args.description === "string" ? args.description.trim() : "";
      const type = args.type;
      const scope = args.scope;
      const content = typeof args.content === "string" ? args.content : "";

      if (!MEMORY_NAME_PATTERN.test(name) || name !== rawName) {
        return {
          error:
            "save_memory name must be a lowercase kebab-case slug of at most 64 characters.",
        };
      }
      if (!description) {
        return { error: "save_memory requires a non-empty description." };
      }
      if (
        description.length > MAX_MEMORY_DESCRIPTION_CHARS ||
        /[\r\n]/.test(description)
      ) {
        return {
          error: `save_memory description must be one line of at most ${MAX_MEMORY_DESCRIPTION_CHARS} characters.`,
        };
      }
      if (
        typeof type !== "string" ||
        !MEMORY_TYPES.includes(type as MemoryType)
      ) {
        return {
          error: `save_memory type must be one of: ${MEMORY_TYPES.join(", ")}.`,
        };
      }
      if (scope !== "global" && scope !== "workspace") {
        return { error: 'save_memory scope must be "global" or "workspace".' };
      }
      if (!content.trim()) {
        return { error: "save_memory requires non-empty content." };
      }
      if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_CONTENT_BYTES) {
        return {
          error: `save_memory content exceeds the ${MAX_MEMORY_CONTENT_BYTES / 1024} KiB limit.`,
        };
      }

      const dir = scope === "global" ? globalDir(home) : workspaceDir(cwd, home);
      const path = join(dir, `${name}.md`);
      const tempPath = join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
      const file = [
        "---",
        `name: ${name}`,
        `description: ${JSON.stringify(description)}`,
        `type: ${type}`,
        "---",
        "",
        content,
      ].join("\n");

      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(tempPath, file, { encoding: "utf8", flag: "wx" });
        renameSync(tempPath, path);
      } catch (error) {
        rmSync(tempPath, { force: true });
        return {
          error:
            error instanceof Error ? error.message : `Could not write ${path}.`,
        };
      }
      try {
        onSaved?.();
      } catch {
        // The note is durable even if refreshing the in-memory catalog fails.
      }
      return { output: `Saved memory "${name}" [${type}/${scope}] to ${path}.` };
    },
  };
}

function findMemoryFiles(root: string, max = MAX_MEMORY_FILES): string[] {
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (files.length >= max) break;
    files.push(join(root, entry.name));
  }
  return files;
}

function readMemoryMetadata(
  path: string,
): Pick<MemoryEntry, "name" | "description" | "type"> | null {
  let content: string;
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_MEMORY_FILE_BYTES) return null;
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
  const rawName =
    readFrontmatterValue(frontmatter, "name") || basename(path, ".md");
  if (!MEMORY_NAME_PATTERN.test(rawName)) return null;
  const name = rawName;
  const description = normalizeDescription(
    readFrontmatterValue(frontmatter, "description"),
  );
  const rawType = readFrontmatterValue(frontmatter, "type");
  const type = MEMORY_TYPES.includes(rawType as MemoryType)
    ? (rawType as MemoryType)
    : "reference";
  return { name, description, type };
}

function readFrontmatterValue(frontmatter: string, key: string): string {
  const raw =
    new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]?.trim() ??
    "";
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1).replace(/\\"/g, '"');
  }
  return raw;
}

function normalizeDescription(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return (
    normalized.slice(0, MAX_MEMORY_DESCRIPTION_CHARS) ||
    "No description provided."
  );
}
