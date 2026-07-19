import { spawnSync } from "node:child_process";

type SpawnSync = (
  command: string,
  args: string[],
) => { status: number | null; error?: Error };

const FD_CANDIDATES = ["fd", "fdfind"];

let cachedPath: string | null | undefined;

/**
 * Locates an `fd` binary on PATH (checking the Debian `fdfind` alias too).
 * Result is memoized for the process lifetime.
 */
export function resolveFdPath(
  run: SpawnSync = (command, args) => spawnSync(command, args, { stdio: "ignore" }),
): string | null {
  if (cachedPath !== undefined) return cachedPath;
  for (const candidate of FD_CANDIDATES) {
    const result = run(candidate, ["--version"]);
    if (!result.error && result.status === 0) {
      cachedPath = candidate;
      return cachedPath;
    }
  }
  cachedPath = null;
  return cachedPath;
}

/** Test-only: clears the memoized fd path so resolveFdPath() re-probes. */
export function resetFdPathCache(): void {
  cachedPath = undefined;
}
