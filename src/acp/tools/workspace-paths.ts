import { isAbsolute, relative, resolve } from "node:path";

export function resolveWorkspacePath(cwd: string, input: unknown): { path: string } | { error: string } {
  const requested = typeof input === "string" && input.trim() ? input : ".";
  const absolute = resolve(cwd, requested);
  const rel = relative(cwd, absolute);

  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return { path: absolute };
  }

  return { error: `Path is outside the workspace: ${requested}` };
}
