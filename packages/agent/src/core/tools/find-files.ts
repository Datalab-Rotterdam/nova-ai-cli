import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { globToRegExp } from "./glob.js";
import type { ToolDefinition } from "./types.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;
/** Directories never searched: dependencies, VCS data and build output. */
const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".next",
  "coverage",
]);
/** Stops runaway walks in huge trees; the result says it was cut. */
const MAX_VISITED_ENTRIES = 200_000;

export const findFilesTool: ToolDefinition = {
  name: "find_files",
  description:
    'find workspace files by glob pattern, e.g. "**/*.test.ts", "src/**/config*" or "*.md" (a pattern without "/" matches file names in any folder). node_modules, .git and build output are skipped.',
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob relative to the workspace root" },
      max_results: { type: "integer", default: DEFAULT_LIMIT },
    },
    required: ["pattern"],
  },
  isAvailable: ({ caps, environment }) => !!caps?.fs?.readTextFile && !!environment?.workspaceReadable,
  mutating: false,
  kind: "search",
  async execute({ cwd, signal }, args) {
    const raw = typeof args.pattern === "string" ? args.pattern.trim() : "";
    if (!raw) return { error: 'find_files requires a glob "pattern".' };
    const pattern = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    if (pattern.split("/").includes("..")) {
      return { error: "find_files searches inside the workspace; the pattern may not contain \"..\"." };
    }
    const limit = normalizeLimit(args.max_results);
    const ignoreCase = process.platform === "win32" || process.platform === "darwin";
    const matcher = globToRegExp(pattern, ignoreCase);
    const byName = !pattern.includes("/");

    const found: string[] = [];
    let visited = 0;
    let cut = false;
    const pending = [cwd];
    while (pending.length && found.length <= limit) {
      if (signal.aborted) return { error: "find_files was cancelled." };
      const directory = pending.pop()!;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue; // unreadable folder: skip it
      }
      for (const entry of entries) {
        if (++visited > MAX_VISITED_ENTRIES) {
          cut = true;
          pending.length = 0;
          break;
        }
        const absolute = join(directory, entry.name);
        // Symbolic links are never followed, so the walk cannot leave the
        // workspace or loop.
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRECTORIES.has(entry.name)) pending.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const path = relative(cwd, absolute).split(sep).join("/");
        if (matcher.test(byName ? entry.name : path)) found.push(path);
      }
    }

    if (found.length === 0) {
      return { output: cut ? "No files found before the search limit was reached; use a narrower pattern." : "No files found." };
    }
    found.sort();
    const more =
      found.length > limit
        ? `\n[More than ${limit} results; use a narrower pattern.]`
        : cut
          ? "\n[The workspace is very large; the search stopped early. Use a narrower pattern.]"
          : "";
    return { output: `${found.slice(0, limit).join("\n")}${more}` };
  },
};

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}
