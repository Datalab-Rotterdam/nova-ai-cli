/*
 * Browser integration, set up the way Claude Code does it for its Chrome extension: this CLI
 * depends on the Nova AI Browser host (@datalabrotterdam/nova-ai-browser-host) and registers it
 * on start-up. The host's installer writes a wrapper and the browsers' native messaging
 * manifests. It changes nothing when everything is current and never replaces a newer host
 * (Nova AI for VS Code and Nova AI Desktop carry one too).
 *
 * - Installed with npm, Node runs the installer, which copies the host to
 *   ~/.nova-ai/browser/host/<version>/ and has browsers start it with this Node.
 * - The standalone binary has no Node to offer, so it carries the host itself:
 *   `nova-ai browser-host …` runs the bundled host, and the installer registers the binary
 *   (`--carrier`), so the browser starts `nova-ai browser-host chrome-extension://…/`.
 *
 * While it is set up, the nova-browser skill from @datalabrotterdam/nova-ai-skills is installed
 * in the Nova home too (read-only, like every bundled skill), so the agent knows how to use it.
 *
 * Off in CI and with NOVA_AI_BROWSER_AUTO_SETUP=0.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { standalone, standaloneAssets, standaloneSkillSource } from "@datalabrotterdam/nova-ai-agent/core/standalone.js";

export interface BrowserSetupResult {
  version: string;
  usedThisVersion: boolean;
  changed: boolean;
  browsers: string[];
  /** Browsers registered for the first time: they read the registration after a restart. */
  newBrowsers: string[];
  node: string;
  skills: string[];
}

/** The CLI's subcommand that runs the browser host it carries (only the binary registers it). */
export const BROWSER_HOST_COMMAND = "browser-host";

/** The skill that tells the agent how to use the browser (in @datalabrotterdam/nova-ai-skills). */
export const BROWSER_SKILL = "nova-browser";

/** How to run the host's command line: a program and the arguments before the host's own. */
export interface HostLaunch {
  command: string;
  args: string[];
  /** Whether the program is this binary, which then also carries the host for the browser. */
  carrier: boolean;
}

export type RunInstaller = (command: string, args: string[]) => Promise<string>;

const runInstaller: RunInstaller = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
      else resolve(stdout);
    });
  });

export function browserSetupDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NOVA_AI_BROWSER_AUTO_SETUP === "0" || Boolean(env.CI);
}

/** The host package's command line, resolved like an import from this module. */
export function bundledInstaller(from: string = import.meta.url): string | undefined {
  try {
    if (standalone()) {
      const installer = join(standaloneAssets(), "browser-host", "dist", "cli.js");
      return existsSync(installer) ? installer : undefined;
    }
    const manifest = createRequire(from).resolve("@datalabrotterdam/nova-ai-browser-host/package.json");
    const installer = join(dirname(manifest), "dist", "cli.js");
    return existsSync(installer) ? installer : undefined;
  } catch {
    return undefined;
  }
}

/** This Node with the host's script, or in a binary the binary itself (`nova-ai browser-host`). */
export function hostLaunch(
  installer = bundledInstaller(),
  binary = standalone() !== null,
  execPath = process.execPath,
): HostLaunch | undefined {
  if (!installer) return undefined;
  return binary
    ? { command: execPath, args: [BROWSER_HOST_COMMAND], carrier: true }
    : { command: execPath, args: [installer], carrier: false };
}

/** The installer prints one JSON line; anything before it (warnings) is ignored. */
export function parseSetupOutput(output: string): BrowserSetupResult {
  const line = output.trim().split("\n").reverse().find((entry) => entry.trim().startsWith("{"));
  if (!line) throw new Error("The browser host installer printed no result.");
  return JSON.parse(line) as BrowserSetupResult;
}

export const INSTALLER_ARGS = ["install", "--auto", "--json"];

/** The installer's arguments; a carrier also registers itself as the program browsers start. */
export function installerArgs(launch: HostLaunch): string[] {
  const own = launch.carrier ? ["--carrier", launch.command, ...launch.args.flatMap((arg) => ["--carrier-arg", arg])] : [];
  return [...launch.args, ...INSTALLER_ARGS, ...own];
}

/** Installs the nova-browser skill, or brings it up to date; returns whether it was written. */
export async function installBrowserSkill(home?: string): Promise<boolean> {
  if (process.env.NOVA_NO_SKILLS_INSTALL) return false;
  const [{ installSkills }, { novaHomeRoot }] = await Promise.all([
    import("@datalabrotterdam/nova-ai-skills"),
    import("@datalabrotterdam/nova-ai-agent/core/nova-home.js"),
  ]);
  const installed = await installSkills(home ?? novaHomeRoot(), { ...standaloneSkillSource(), include: [BROWSER_SKILL] });
  return installed.includes(BROWSER_SKILL);
}

export async function setUpBrowser(
  run: RunInstaller = runInstaller,
  launch = hostLaunch(),
  skill: () => Promise<unknown> = installBrowserSkill,
): Promise<BrowserSetupResult> {
  if (!launch) throw new Error("The bundled Nova AI Browser host is missing from this installation.");
  const result = parseSetupOutput(await run(launch.command, installerArgs(launch)));
  await skill();
  return result;
}

/**
 * Start-up check, fire and forget: a detached process with no output, so it never holds up
 * the command, never keeps it alive and never writes into the TUI or the ACP stream. The skill
 * is installed alongside; a failure is retried at the next start.
 */
export function setUpBrowserInBackground(launch = hostLaunch(), skill: () => Promise<unknown> = installBrowserSkill): void {
  if (browserSetupDisabled() || !launch) return;
  try {
    spawn(launch.command, installerArgs(launch), { detached: true, stdio: "ignore", windowsHide: true })
      .on("error", () => {})
      .unref();
  } catch {
    // Not being able to set up the browser must never break the CLI.
  }
  skill().catch(() => undefined);
}

/**
 * `nova-ai browser-host …`: runs the host's command line in this process. Browsers start the
 * binary this way (stdout is their native messaging channel, so nothing else may write to it),
 * and the setup runs its installer this way.
 */
export async function runBrowserHost(args: string[], installer = bundledInstaller()): Promise<void> {
  if (!installer) throw new Error("The bundled Nova AI Browser host is missing from this installation.");
  // The host reads its arguments from process.argv, after the program and script.
  process.argv.splice(2, process.argv.length - 2, ...args);
  await import(pathToFileURL(installer).href);
}

export function describeBrowserSetup(result: BrowserSetupResult): string {
  if (!result.browsers.length) {
    return "Browser: no Chromium-based browser (Chrome, Edge, Brave, …) found for this user.";
  }
  const restart = result.newBrowsers.length ? ` Restart ${result.newBrowsers.join(", ")} once so it picks this up.` : "";
  return `Browser: Nova can use ${result.browsers.join(", ")} through the Nova AI browser extension.${restart}`;
}
