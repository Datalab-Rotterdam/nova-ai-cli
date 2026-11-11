import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

/**
 * `~/.nova-ai`, shared with the VS Code extension (nova-ai-vscode
 * src/storage/NovaHome.ts). The project key algorithm must stay identical to
 * the extension's, so both tools use the same folder for one workspace:
 *
 * ```
 * ~/.nova-ai/
 *   credentials.json  model-capabilities.json  background-jobs/
 *   projects/<slug>-<hash8>/
 *     project.json     (shared: where the folder came from)
 *     sessions/        (VS Code panel sessions: index.json + <id>.json)
 *     cli-sessions/    (nova-ai-cli sessions: <id>.jsonl)
 * ```
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SLUG_MAX_LENGTH = 40;

/** `NOVA_AI_HOME` or `~/.nova-ai`. */
export function novaHomeRoot(): string {
  return process.env.NOVA_AI_HOME?.trim() || join(homedir(), ".nova-ai");
}

export function projectsDir(): string {
  return join(novaHomeRoot(), "projects");
}

export type ProjectPaths = {
  key: string;
  dir: string;
  info: string;
  /** Private per-project settings (permission rules, mode); never in the repo. */
  settings: string;
  cliSessions: string;
};

export function projectPaths(cwd: string): ProjectPaths {
  const key = workspaceKey(cwd);
  const dir = join(projectsDir(), key);
  return {
    key,
    dir,
    info: join(dir, "project.json"),
    settings: join(dir, "settings.json"),
    cliSessions: join(dir, "cli-sessions"),
  };
}

/** Creates the project folder and records (or refreshes) where it came from. */
export function ensureProject(cwd: string): ProjectPaths {
  const paths = projectPaths(cwd);
  mkdirSync(paths.dir, { recursive: true, mode: DIR_MODE });
  const now = new Date().toISOString();
  const workspacePath = resolve(cwd);
  let info: Record<string, unknown> = {
    path: workspacePath,
    name: basename(workspacePath),
    createdAt: now,
    lastOpenedAt: now,
  };
  try {
    const existing = JSON.parse(readFileSync(paths.info, "utf8"));
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      info = { ...existing, path: workspacePath, lastOpenedAt: now };
    }
  } catch {
    // first time
  }
  try {
    writeFileSync(paths.info, `${JSON.stringify(info, null, 2)}\n`, {
      mode: FILE_MODE,
    });
  } catch {
    // project.json is informational; sessions must not fail because of it
  }
  return paths;
}

/**
 * `<slug>-<hash8>`, as in the extension: readable, collision-free, fixed
 * length and valid on every OS.
 */
export function workspaceKey(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const slug = slugify(basename(resolve(cwd))) || "workspace";
  const hash = createHash("sha256")
    .update(normalizeWorkspacePath(cwd, platform))
    .digest("hex")
    .slice(0, 8);
  return `${slug}-${hash}`;
}

export function normalizeWorkspacePath(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let resolved = resolve(cwd);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // Not on this disk (yet): use the path as given.
  }
  const pathApi = platform === "win32" ? win32 : posix;
  let normalized = pathApi.normalize(resolved);
  while (
    normalized.length > 1 &&
    /[\\/]$/.test(normalized) &&
    !/^[a-zA-Z]:\\$/.test(normalized)
  ) {
    normalized = normalized.slice(0, -1);
  }
  // Default file systems on Windows and macOS are case-insensitive.
  return platform === "win32" || platform === "darwin"
    ? normalized.toLowerCase()
    : normalized;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/[-.]+$/g, "");
}

/**
 * Whether the user trusts this workspace's own files: allow rules in
 * `<ws>/.nova-ai/settings*.json` and MCP servers the workspace declares. A
 * cloned repository must not be able to approve its own commands, so trust is
 * stored outside it, in project.json.
 */
export function isWorkspaceTrusted(cwd: string): boolean {
  try {
    const info = JSON.parse(readFileSync(projectPaths(cwd).info, "utf8"));
    return info?.trusted === true;
  } catch {
    return false;
  }
}

export function setWorkspaceTrusted(cwd: string, trusted: boolean): void {
  const paths = ensureProject(cwd);
  const info = JSON.parse(readFileSync(paths.info, "utf8")) as Record<string, unknown>;
  writePrivateFile(paths.info, `${JSON.stringify({ ...info, trusted }, null, 2)}\n`);
}

/** Atomic (temp file + rename), owner-only write, creating the folder. */
export function writePrivateFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: FILE_MODE });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
