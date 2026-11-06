/*
 * Browser integration, set up the way Claude Code does it for its Chrome extension: this CLI
 * depends on the Nova AI Browser host (@datalabrotterdam/nova-ai-browser-host) and registers it
 * on start-up. The host's installer copies itself to ~/.nova-ai/browser/host/<version>/, writes
 * a wrapper and the browsers' native messaging manifests, and installs the nova-browser skill
 * (which the agent then offers like any other skill). It changes nothing when everything is
 * current and never replaces a newer host (Nova AI for VS Code ships one too).
 *
 * The standalone binary carries the host too, but browsers start it through Node and a binary
 * has no Node to offer: there it needs a Node 20+ on PATH, and is skipped without one.
 *
 * Off in CI and with NOVA_AI_BROWSER_AUTO_SETUP=0.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { standalone, standaloneAssets } from "@datalabrotterdam/nova-ai-agent/core/standalone.js";

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

/** The installer prints one JSON line; anything before it (warnings) is ignored. */
export function parseSetupOutput(output: string): BrowserSetupResult {
  const line = output.trim().split("\n").reverse().find((entry) => entry.trim().startsWith("{"));
  if (!line) throw new Error("The browser host installer printed no result.");
  return JSON.parse(line) as BrowserSetupResult;
}

export const INSTALLER_ARGS = ["install", "--auto", "--json"];

/** The oldest Node the browser host runs on (its engines field). */
const MIN_NODE_MAJOR = 20;

/** Why browser integration is unavailable in a binary; worth telling the user, unlike other failures. */
export class BrowserNeedsNodeError extends Error {
  constructor() {
    super(`Browser: the Nova AI browser extension needs Node.js ${MIN_NODE_MAJOR} or newer on PATH. Install it and run nova-ai login again.`);
  }
}

const nodeVersion = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(path, ["--version"], { encoding: "utf8", timeout: 5_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

/**
 * The first suitable Node on PATH. Only absolute entries count: an empty or relative one
 * means the current folder, and a workspace must not get its own `node` executed.
 */
export async function findNode(env: NodeJS.ProcessEnv = process.env, version = nodeVersion): Promise<string | undefined> {
  const file = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, file);
    if (!existsSync(candidate)) continue;
    const major = /^v(\d+)\./.exec(await version(candidate).catch(() => ""))?.[1];
    if (Number(major) >= MIN_NODE_MAJOR) return candidate;
  }
  return undefined;
}

/** What runs the installer: this Node, or in a binary (where execPath is nova-ai itself) one from PATH. */
const installerNode = async (): Promise<string | undefined> => (standalone() ? findNode() : process.execPath);

export async function setUpBrowser(
  run: RunInstaller = runInstaller,
  installer = bundledInstaller(),
  node: () => Promise<string | undefined> = installerNode,
): Promise<BrowserSetupResult> {
  if (!installer) throw new Error("The bundled Nova AI Browser host is missing from this installation.");
  const path = await node();
  if (!path) throw new BrowserNeedsNodeError();
  return parseSetupOutput(await run(path, [installer, ...INSTALLER_ARGS]));
}

/**
 * Start-up check, fire and forget: a detached process with no output, so it never holds up
 * the command, never keeps it alive and never writes into the TUI or the ACP stream.
 */
export function setUpBrowserInBackground(installer = bundledInstaller()): void {
  if (browserSetupDisabled() || !installer) return;
  const launch = (node: string): void => {
    try {
      spawn(node, [installer, ...INSTALLER_ARGS], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // Not being able to set up the browser must never break the CLI.
    }
  };
  if (!standalone()) {
    launch(process.execPath);
    return;
  }
  findNode().then((node) => {
    if (node) launch(node);
  }, () => undefined);
}

export function describeBrowserSetup(result: BrowserSetupResult): string {
  if (!result.browsers.length) {
    return "Browser: no Chromium-based browser (Chrome, Edge, Brave, …) found for this user.";
  }
  const restart = result.newBrowsers.length ? ` Restart ${result.newBrowsers.join(", ")} once so it picks this up.` : "";
  return `Browser: Nova can use ${result.browsers.join(", ")} through the Nova AI browser extension.${restart}`;
}
