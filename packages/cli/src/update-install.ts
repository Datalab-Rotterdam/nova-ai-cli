import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import type { UpdateAvailable } from "./tui/state/types.js";
import { rememberUpdateAnswer, shouldAskAboutUpdate } from "./update-check.js";
import { CLI_PACKAGE_NAME } from "./version.js";

/** How long start-up waits for npm before opening the TUI without asking. */
const START_WAIT_MS = 1_500;
/** Set on the restarted process: it says what was updated and does not ask again. */
export const UPDATED_FROM_ENV = "NOVA_UPDATED_FROM";

export type UpdateAnswer = "update" | "later" | "skip";

export type GlobalInstallOptions = {
  /** The running script; defaults to process.argv[1]. */
  scriptPath?: string;
  platform?: NodeJS.Platform;
};

/**
 * The npm prefix nova-ai was installed into with `npm install -g`, the one
 * install it can replace itself: `<prefix>/lib/node_modules/<package>` with
 * `<prefix>/bin/nova-ai` (on Windows `<prefix>\node_modules\<package>` with
 * `<prefix>\nova-ai.cmd`). Null for npx, a project dependency, another
 * package manager or a source checkout; those only get the reminder. Worked
 * out from the path instead of `npm root -g`, which may belong to another
 * Node than the one running nova-ai (and masks UUID-like path parts).
 */
export function globalNpmPrefix(options: GlobalInstallOptions = {}): string | null {
  const script = options.scriptPath ?? process.argv[1];
  if (!script) return null;
  const windows = (options.platform ?? process.platform) === "win32";
  const marker = `${sep}node_modules${sep}${CLI_PACKAGE_NAME.split("/").join(sep)}${sep}`;
  const resolved = realPath(script);
  const at = resolved.lastIndexOf(marker);
  if (at < 0) return null;
  const nodeModulesParent = resolved.slice(0, at);
  const prefix = windows ? nodeModulesParent : dirname(nodeModulesParent);
  if (!windows && nodeModulesParent !== join(prefix, "lib")) return null;
  return existsSync(join(prefix, windows ? "nova-ai.cmd" : join("bin", "nova-ai"))) ? prefix : null;
}

/** Adds `installable` to a found update. */
export async function withInstallability(
  update: UpdateAvailable | null,
  options: GlobalInstallOptions = {},
): Promise<UpdateAvailable | null> {
  if (!update) return null;
  return { ...update, installable: globalNpmPrefix(options) !== null };
}

/** npm is npm.cmd on Windows, which only runs through a shell. */
function npmInvocation(args: string[]): [string, string[], boolean] {
  return process.platform === "win32"
    ? [`npm ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ")}`, [], true]
    : ["npm", args, false];
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Enter or y updates, s skips this version, anything else is "not today". */
export function parseUpdateAnswer(answer: string): UpdateAnswer {
  const value = answer.trim().toLowerCase();
  if (value === "" || value === "y" || value === "yes") return "update";
  if (value === "s" || value === "skip") return "skip";
  return "later";
}

async function askToUpdate(update: UpdateAvailable): Promise<UpdateAnswer> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nUpdate available: nova-ai ${update.currentVersion} → ${update.latestVersion}`);
    return parseUpdateAnswer(
      await prompt.question("Update now? [Y/n/s] (n: not today, s: skip this version) "),
    );
  } finally {
    prompt.close();
  }
}

/**
 * Asks before the TUI opens when a newer version is known (the daily cache
 * answers at once; npm gets START_WAIT_MS, after which the TUI only shows
 * the reminder). Returns the restarted process's exit code, or null to go
 * on with this version.
 */
export async function offerUpdateAtStart(
  check: Promise<UpdateAvailable | null>,
  restartArgs: string[],
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = await Promise.race([
    check,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), START_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (!update?.installable || !shouldAskAboutUpdate(update)) return null;
  const answer = await askToUpdate(update);
  if (answer !== "update") {
    rememberUpdateAnswer(answer, update);
    console.log(
      answer === "skip"
        ? `Skipping ${update.latestVersion}; you'll be asked again for a newer version.`
        : "Not now. /update installs it any time.",
    );
    return null;
  }
  return installAndRestart(update, restartArgs);
}

/**
 * `npm install -g` the update in the foreground, then runs the new nova-ai
 * with `restartArgs` and returns its exit code. Null when the install
 * failed; this version then keeps running.
 */
export function installAndRestart(update: UpdateAvailable, restartArgs: string[]): number | null {
  const prefix = globalNpmPrefix();
  if (!prefix) return null;
  console.log(`\nInstalling nova-ai ${update.latestVersion}…`);
  // Into the prefix this copy runs from, whichever npm is first on PATH.
  const [file, args, shell] = npmInvocation(["install", "-g", "--prefix", prefix, `${CLI_PACKAGE_NAME}@${update.tag}`]);
  const install = spawnSync(file, args, { stdio: "inherit", shell });
  if (install.status !== 0) {
    console.error(`\nThe update did not install. Run it yourself: ${update.command}\n`);
    return null;
  }
  const script = process.argv[1];
  if (!script) return null;
  // The installed files changed under this process, so the new version runs
  // in a fresh one; this process only waits for it and passes on its code.
  const restarted = spawnSync(process.execPath, [...process.execArgv, script, ...restartArgs], {
    stdio: "inherit",
    env: { ...process.env, [UPDATED_FROM_ENV]: update.currentVersion },
  });
  return restarted.status ?? 1;
}
