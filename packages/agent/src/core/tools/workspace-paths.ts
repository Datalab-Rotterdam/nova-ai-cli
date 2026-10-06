import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { bundledSkillMessage, bundledSkillOf } from "../skills.js";

export function resolveWorkspacePath(cwd: string, input: unknown): { path: string } | { error: string } {
  const requested = typeof input === "string" && input.trim() ? input : ".";
  const absolute = resolve(cwd, requested);

  if (isInside(cwd, absolute)) {
    return { path: absolute };
  }

  return { error: `Path is outside the workspace: ${requested}` };
}

/**
 * Like {@link resolveWorkspacePath}, for tools that read or write file
 * contents: relative paths resolve against the session cwd (never the agent
 * process cwd), and symlinks are followed so a link inside the workspace
 * cannot expose or overwrite a file outside it. Paths that do not exist yet
 * are checked through their nearest existing ancestor. The returned path is
 * the lexical one, which is what clients expect to see.
 */
export async function resolveWorkspaceFile(
  cwd: string,
  input: unknown,
): Promise<{ path: string } | { error: string }> {
  if (typeof input !== "string" || !input.trim()) {
    return { error: "A non-empty 'path' is required." };
  }
  const lexical = resolveWorkspacePath(cwd, input);
  if ("error" in lexical) return lexical;

  // Both sides go through the same resolution, so a workspace that does not
  // exist yet (or sits under a symlinked temp dir) still compares equal.
  const root = await realpathOfNearestExisting(resolve(cwd));
  const target = await realpathOfNearestExisting(lexical.path);
  if (!isInside(root, target)) {
    return {
      error: `Path resolves outside the workspace through a symbolic link: ${input}`,
    };
  }
  return lexical;
}

/**
 * Like {@link resolveWorkspaceFile}, for tools that change files: bundled skills
 * (shipped and updated by a Nova app) are read-only and can only be switched off.
 */
export async function resolveEditableWorkspaceFile(
  cwd: string,
  input: unknown,
): Promise<{ path: string } | { error: string }> {
  const resolved = await resolveWorkspaceFile(cwd, input);
  if ("error" in resolved) return resolved;
  const bundled = bundledSkillOf(resolved.path);
  return bundled ? { error: bundledSkillMessage(bundled) } : resolved;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function realpathOfNearestExisting(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(basename(current));
      current = parent;
    }
  }
}
