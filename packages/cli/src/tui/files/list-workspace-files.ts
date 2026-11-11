import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".nova-ai", "out", "coverage", ".next", ".turbo"]);

export function listWorkspaceFiles(cwd: string, max = 2000): string[] {
  const results: string[] = [];
  const stack: string[] = [cwd];

  while (stack.length > 0 && results.length < max) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (results.length >= max) break;
      if (entry.isSymbolicLink()) continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        results.push(relative(cwd, full).split(sep).join("/"));
      }
    }
  }

  return results;
}
