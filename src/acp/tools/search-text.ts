import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { resolveWorkspacePath } from "./workspace-paths.js";
import type { ToolDefinition } from "./types.js";

const DEFAULT_EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "dist-test", "coverage", ".next"]);
const DEFAULT_MAX_MATCHES = 100;
const MAX_MATCHES = 500;
const MAX_FILE_BYTES = 1_000_000;

export const searchTextTool: ToolDefinition = {
  name: "search_text",
  description:
    'search_text: {"query": "<text or regex>", "path": "<optional workspace path>", "regex": false, "case_sensitive": false, "include_extensions": [".ts"], "exclude_dirs": ["node_modules"], "max_matches": 100} - search text files under the workspace without grep/rg.',
  isAvailable: ({ caps, environment }) => !!caps?.fs?.readTextFile && !!environment?.workspaceReadable,
  mutating: false,
  kind: "search",
  async execute({ cwd }, args) {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query) return { error: "search_text requires a 'query' argument." };

    const resolved = resolveWorkspacePath(cwd, args.path);
    if ("error" in resolved) return { error: resolved.error };

    const maxMatches = normalizeLimit(args.max_matches, DEFAULT_MAX_MATCHES, MAX_MATCHES);
    const includeExtensions = normalizeExtensions(args.include_extensions);
    const excludeDirs = new Set([...DEFAULT_EXCLUDED_DIRS, ...normalizeStringArray(args.exclude_dirs)]);

    let pattern: RegExp;
    try {
      pattern = new RegExp(args.regex === true ? query : escapeRegExp(query), args.case_sensitive === true ? "g" : "gi");
    } catch (err) {
      return { error: err instanceof Error ? `Invalid regular expression: ${err.message}` : "Invalid regular expression." };
    }

    try {
      const files = await collectFiles(resolved.path, cwd, includeExtensions, excludeDirs);
      const matches: string[] = [];

      for (const file of files) {
        if (matches.length >= maxMatches) break;
        const content = await readTextCandidate(file);
        if (content === null) continue;

        const lines = content.split(/\r?\n/);
        for (let lineIndex = 0; lineIndex < lines.length && matches.length < maxMatches; lineIndex += 1) {
          pattern.lastIndex = 0;
          const match = pattern.exec(lines[lineIndex]);
          if (!match) continue;
          matches.push(`${relative(cwd, file)}:${lineIndex + 1}:${match.index + 1}: ${lines[lineIndex].trim()}`);
        }
      }

      if (!matches.length) return { output: "No matches found." };
      const omitted = matches.length >= maxMatches ? `\n[stopped after ${maxMatches} matches]` : "";
      return { output: `${matches.join("\n")}${omitted}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to search text." };
    }
  },
};

async function collectFiles(
  root: string,
  cwd: string,
  includeExtensions: Set<string> | null,
  excludeDirs: Set<string>,
): Promise<string[]> {
  const rootInfo = await stat(root);
  if (rootInfo.isFile()) return shouldIncludeFile(root, includeExtensions) ? [root] : [];
  if (!rootInfo.isDirectory()) return [];

  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name)) await visit(absolute);
      } else if (entry.isFile() && shouldIncludeFile(absolute, includeExtensions)) {
        files.push(absolute);
      }
    }
  };

  await visit(root);
  return files.sort((a, b) => relative(cwd, a).localeCompare(relative(cwd, b)));
}

function shouldIncludeFile(path: string, includeExtensions: Set<string> | null): boolean {
  return !includeExtensions || includeExtensions.has(extname(path).toLowerCase());
}

async function readTextCandidate(path: string): Promise<string | null> {
  const info = await stat(path);
  if (info.size > MAX_FILE_BYTES) return null;

  const content = await readFile(path, "utf8");
  if (content.includes("\u0000")) return null;
  return content;
}

function normalizeExtensions(value: unknown): Set<string> | null {
  const extensions = normalizeStringArray(value)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`))
    .map((extension) => extension.toLowerCase());
  return extensions.length ? new Set(extensions) : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
