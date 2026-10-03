import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const KILL_GRACE_MS = 1_000;

export type SpawnCommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** When given, `command` is executed directly with these args (no shell). */
  args?: string[];
};

/** Children that are still running, so they can be stopped when the CLI exits. */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/**
 * Spawns a non-interactive command in its own process group (POSIX), so a
 * stop also ends everything it started: shells often fork instead of exec
 * (dash, `a && b`), and npm/yarn spawn node. stdin is closed so a command
 * that prompts for input fails instead of hanging forever.
 */
export function spawnCommand(
  command: string,
  options: SpawnCommandOptions,
): ChildProcess {
  installExitHook();
  const common = {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
  const child = options.args?.length
    ? spawn(command, options.args, common)
    : spawn(command, { ...common, shell: true });

  liveChildren.add(child);
  const forget = () => liveChildren.delete(child);
  child.once("exit", forget);
  child.once("error", forget);
  return child;
}

/** Sends `signal` to the child's whole process tree. Safe to call after exit. */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      // taskkill /T walks the tree; /F because Windows has no SIGTERM.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", () => {});
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    // No such process group (already gone): fall back to the child itself.
    try {
      child.kill(signal);
    } catch {
      // already exited
    }
  }
}

/**
 * SIGTERM to the tree, then SIGKILL if it is still running after the grace
 * period. Resolves once the child has exited, or after the escalation for a
 * child that never reports exit.
 */
export function terminateProcessTree(
  child: ChildProcess,
  graceMs = KILL_GRACE_MS,
): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(forceTimer);
      clearTimeout(giveUpTimer);
      resolve();
    };
    child.once("exit", done);
    killProcessTree(child, "SIGTERM");
    forceTimer = setTimeout(() => {
      killProcessTree(child, "SIGKILL");
      // A zombie or a tree whose leader already exited may never emit again.
      giveUpTimer = setTimeout(done, graceMs);
    }, graceMs);
  });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Detached process groups no longer receive the terminal's Ctrl-C, so
  // anything still running is stopped synchronously when the CLI exits.
  // Only synchronous work runs in an exit handler, so Windows (where tree
  // kills need a taskkill child process) gets spawnSync.
  process.once("exit", () => {
    for (const child of liveChildren) {
      if (process.platform === "win32" && child.pid !== undefined) {
        try {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 2_000,
          });
        } catch {
          // best-effort
        }
      } else {
        killProcessTree(child, "SIGKILL");
      }
    }
    liveChildren.clear();
  });
}

/** Test seam: number of children spawned here that have not exited yet. */
export function liveChildCount(): number {
  return liveChildren.size;
}
