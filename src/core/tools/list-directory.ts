import { readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { resolveWorkspacePath } from "./workspace-paths.js";
import type { ToolDefinition } from "./types.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;

export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: "list files and directories under the workspace without shell dependencies.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "optional workspace path" },
      max_entries: { type: "integer", default: DEFAULT_LIMIT },
      include_hidden: { type: "boolean", default: false },
    },
  },
  isAvailable: ({ caps, environment }) => !!caps?.fs?.readTextFile && !!environment?.workspaceReadable,
  mutating: false,
  kind: "search",
  async execute({ cwd }, args) {
    const resolved = resolveWorkspacePath(cwd, args.path);
    if ("error" in resolved) return { error: resolved.error };

    const includeHidden = args.include_hidden === true;
    const limit = normalizeLimit(args.max_entries, DEFAULT_LIMIT, MAX_LIMIT);

    try {
      const info = await stat(resolved.path);
      if (!info.isDirectory()) return { error: `Path is not a directory: ${resolved.path}` };

      const entries = await readdir(resolved.path, { withFileTypes: true });
      const visibleEntries = includeHidden ? entries : entries.filter((entry) => !entry.name.startsWith("."));
      visibleEntries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

      const rows = await Promise.all(
        visibleEntries.slice(0, limit).map(async (entry) => {
          const absolute = join(resolved.path, entry.name);
          const rel = relative(cwd, absolute) || basename(absolute);
          const kind = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other";
          const size = entry.isFile() ? ` ${await fileSize(absolute)} bytes` : "";
          return `${kind.padEnd(5)} ${rel}${entry.isDirectory() ? "/" : ""}${size}`;
        }),
      );

      const omitted = visibleEntries.length > limit ? `\n[${visibleEntries.length - limit} entries omitted]` : "";
      return { output: rows.length ? `${rows.join("\n")}${omitted}` : "(empty directory)" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to list directory." };
    }
  },
};

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
