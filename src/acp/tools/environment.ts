import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

export type PackageManager = "npm" | "pnpm" | "yarn";

export type ToolEnvironment = {
  platform: NodeJS.Platform | string;
  commands: Record<string, boolean>;
  packageManager: PackageManager | null;
  packageScripts: string[];
  workspaceReadable: boolean;
  clientCapabilities: acp.ClientCapabilities | undefined;
};

export type ToolAvailabilityContext = {
  caps: acp.ClientCapabilities | undefined;
  environment: ToolEnvironment | undefined;
  background?: boolean;
};

const COMMANDS_TO_PROBE = ["git", "node", "npm", "pnpm", "yarn", "python", "python3", "rg"] as const;

export async function detectToolEnvironment(
  cwd: string,
  caps: acp.ClientCapabilities | undefined,
): Promise<ToolEnvironment> {
  const [workspaceReadable, commands, packageInfo] = await Promise.all([
    canAccess(cwd),
    detectCommands(),
    detectPackageInfo(cwd),
  ]);

  return {
    platform: process.platform,
    commands,
    packageManager: choosePackageManager(packageInfo.lockfiles, commands),
    packageScripts: packageInfo.packageScripts,
    workspaceReadable,
    clientCapabilities: caps,
  };
}

export function fallbackToolEnvironment(
  cwd: string,
  caps: acp.ClientCapabilities | undefined,
): Promise<ToolEnvironment> {
  return detectToolEnvironment(cwd, caps).catch(() => ({
    platform: process.platform,
    commands: {},
    packageManager: null,
    packageScripts: [],
    workspaceReadable: false,
    clientCapabilities: caps,
  }));
}

async function detectCommands(): Promise<Record<string, boolean>> {
  const entries = await Promise.all(COMMANDS_TO_PROBE.map(async (command) => [command, await commandExists(command)]));
  return Object.fromEntries(entries);
}

async function commandExists(command: string): Promise<boolean> {
  const lookup = process.platform === "win32" ? `where ${quoteForShell(command)}` : `command -v ${quoteForShell(command)}`;

  return new Promise((resolve) => {
    const child = spawn(lookup, { shell: true, stdio: "ignore" });
    const timeout = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 2_000);

    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

async function detectPackageInfo(cwd: string): Promise<{
  lockfiles: Partial<Record<PackageManager, boolean>>;
  packageScripts: string[];
}> {
  const [packageJson, npmLock, pnpmLock, yarnLock] = await Promise.all([
    readPackageJson(cwd),
    canAccess(join(cwd, "package-lock.json")),
    canAccess(join(cwd, "pnpm-lock.yaml")),
    canAccess(join(cwd, "yarn.lock")),
  ]);

  return {
    lockfiles: { npm: npmLock, pnpm: pnpmLock, yarn: yarnLock },
    packageScripts: packageJson,
  };
}

async function readPackageJson(cwd: string): Promise<string[]> {
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== "object") return [];
    return Object.keys(parsed.scripts).sort();
  } catch {
    return [];
  }
}

async function canAccess(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function choosePackageManager(
  lockfiles: Partial<Record<PackageManager, boolean>>,
  commands: Record<string, boolean>,
): PackageManager | null {
  const preference: PackageManager[] = lockfiles.pnpm ? ["pnpm", "npm", "yarn"] : lockfiles.yarn ? ["yarn", "npm", "pnpm"] : ["npm", "pnpm", "yarn"];
  const locked = preference.find((manager) => lockfiles[manager] && commands[manager]);
  if (locked) return locked;
  return preference.find((manager) => commands[manager]) ?? null;
}

function quoteForShell(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
