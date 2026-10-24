/*
 * Browser integration, set up the way Claude Code does it for its Chrome extension: this CLI
 * depends on the Nova AI Browser host (@datalabrotterdam/nova-ai-browser-host) and registers it
 * on start-up. The host's installer copies itself to ~/.nova-ai-browser/host/<version>/, writes
 * a wrapper and the browsers' native messaging manifests, and installs the nova-browser skill
 * (which the agent then offers like any other skill). It changes nothing when everything is
 * current and never replaces a newer host (Nova AI for VS Code ships one too).
 *
 * Off in CI and with NOVA_AI_BROWSER_AUTO_SETUP=0.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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

export type RunInstaller = (node: string, args: string[]) => Promise<string>;

const runInstaller: RunInstaller = (node, args) =>
  new Promise((resolve, reject) => {
    execFile(node, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
      else resolve(stdout);
    });
  });

export function browserSetupDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NOVA_AI_BROWSER_AUTO_SETUP === "0" || Boolean(env.CI);
}

/** The host package's installer, resolved like an import from this module. */
export function bundledInstaller(from: string = import.meta.url): string | undefined {
  try {
    const manifest = createRequire(from).resolve("@datalabrotterdam/nova-ai-browser-host/package.json");
    const installer = join(dirname(manifest), "dist", "cli.js");
    return existsSync(installer) ? installer : undefined;
  } catch {
    return undefined;
  }
}

/** The installer prints one JSON line; anything before it (warnings) is ignored. */
export function parseSetupOutput(output: string): BrowserSetupResult {
  const line = output.trim().split("\n").reverse().find((entry) => entry.trim().startsWith("{"));
  if (!line) throw new Error("The browser host installer printed no result.");
  return JSON.parse(line) as BrowserSetupResult;
}

export const INSTALLER_ARGS = ["install", "--auto", "--json"];

export async function setUpBrowser(run: RunInstaller = runInstaller, installer = bundledInstaller()): Promise<BrowserSetupResult> {
  if (!installer) throw new Error("The bundled Nova AI Browser host is missing from this installation.");
  return parseSetupOutput(await run(process.execPath, [installer, ...INSTALLER_ARGS]));
}

/**
 * Start-up check, fire and forget: a detached process with no output, so it never holds up
 * the command, never keeps it alive and never writes into the TUI or the ACP stream.
 */
export function setUpBrowserInBackground(installer = bundledInstaller()): void {
  if (browserSetupDisabled() || !installer) return;
  try {
    spawn(process.execPath, [installer, ...INSTALLER_ARGS], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Not being able to set up the browser must never break the CLI.
  }
}

export function describeBrowserSetup(result: BrowserSetupResult): string {
  if (!result.browsers.length) {
    return "Browser: no Chromium-based browser (Chrome, Edge, Brave, …) found for this user.";
  }
  const restart = result.newBrowsers.length ? ` Restart ${result.newBrowsers.join(", ")} once so it picks this up.` : "";
  return `Browser: Nova can use ${result.browsers.join(", ")} through the Nova AI browser extension.${restart}`;
}
