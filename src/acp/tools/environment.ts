import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

export type PackageManager = "npm" | "pnpm" | "yarn";

export type DockerEnvironment = {
  installed: boolean;
  clientVersion: string | null;
  daemonAvailable: boolean;
  serverVersion: string | null;
  osType: string | null;
  architecture: string | null;
  context: string | null;
  composeCommand: "docker compose" | "docker-compose" | null;
  composeVersion: string | null;
};

export type CommandProbe = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ exitCode: number | null; output: string }>;

export type ToolEnvironment = {
  platform: NodeJS.Platform | string;
  commands: Record<string, boolean>;
  commandPaths: Record<string, string[]>;
  environmentVariableNames: string[];
  toolingEnvironmentVariables: Record<string, string>;
  pathEntries: string[];
  docker: DockerEnvironment;
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

const COMMANDS_TO_PROBE = [
  "git",
  "gh",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "python",
  "python3",
  "py",
  "pip",
  "pip3",
  "uv",
  "rg",
  "fd",
  "grep",
  "jq",
  "curl",
  "pwsh",
  "powershell",
  "bash",
  "docker",
  "docker-compose",
  "kubectl",
  "helm",
  "az",
  "terraform",
  "go",
  "cargo",
  "rustc",
  "java",
  "dotnet",
] as const;

const TOOLING_ENVIRONMENT_VARIABLES = [
  "PATHEXT",
  "COMSPEC",
  "SHELL",
  "TERM",
  "TERM_PROGRAM",
  "WSL_DISTRO_NAME",
  "PSModulePath",
  "NODE_PATH",
  "NVM_HOME",
  "NVM_SYMLINK",
  "PNPM_HOME",
  "BUN_INSTALL",
  "DENO_INSTALL",
  "PYENV_ROOT",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "JAVA_HOME",
  "MAVEN_HOME",
  "GRADLE_HOME",
  "DOTNET_ROOT",
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "KUBECONFIG",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
] as const;

const DOCKER_ENVIRONMENT_CACHE_TTL_MS = 5_000;
let dockerEnvironmentCache:
  | {
      key: string;
      expiresAt: number;
      value: Promise<DockerEnvironment>;
    }
  | undefined;

export async function detectToolEnvironment(
  cwd: string,
  caps: acp.ClientCapabilities | undefined,
): Promise<ToolEnvironment> {
  const [workspaceReadable, commandInventory, packageInfo] = await Promise.all([
    canAccess(cwd),
    detectCommands(),
    detectPackageInfo(cwd),
  ]);
  const environmentInventory = inventoryEnvironmentVariables(
    process.env,
    process.platform,
  );
  const docker = await cachedDockerEnvironment(
    commandInventory.commands.docker ?? false,
    commandInventory.commands["docker-compose"] ?? false,
  );

  return {
    platform: process.platform,
    commands: commandInventory.commands,
    commandPaths: commandInventory.commandPaths,
    ...environmentInventory,
    docker,
    packageManager: choosePackageManager(
      packageInfo.lockfiles,
      commandInventory.commands,
    ),
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
    commandPaths: {},
    ...inventoryEnvironmentVariables(process.env, process.platform),
    docker: emptyDockerEnvironment(),
    packageManager: null,
    packageScripts: [],
    workspaceReadable: false,
    clientCapabilities: caps,
  }));
}

function cachedDockerEnvironment(
  dockerInstalled: boolean,
  legacyComposeInstalled: boolean,
): Promise<DockerEnvironment> {
  const key = JSON.stringify([
    dockerInstalled,
    legacyComposeInstalled,
    environmentValue(process.env, "DOCKER_HOST", process.platform),
    environmentValue(process.env, "DOCKER_CONTEXT", process.platform),
  ]);
  const now = Date.now();
  if (
    dockerEnvironmentCache?.key === key &&
    dockerEnvironmentCache.expiresAt > now
  ) {
    return dockerEnvironmentCache.value;
  }

  const value = detectDockerEnvironment(
    dockerInstalled,
    legacyComposeInstalled,
  );
  dockerEnvironmentCache = {
    key,
    expiresAt: now + DOCKER_ENVIRONMENT_CACHE_TTL_MS,
    value,
  };
  return value;
}

export async function detectDockerEnvironment(
  dockerInstalled: boolean,
  legacyComposeInstalled: boolean,
  probe: CommandProbe = runCommandProbe,
): Promise<DockerEnvironment> {
  if (!dockerInstalled) {
    const legacyCompose = legacyComposeInstalled
      ? await probe("docker-compose", ["version", "--short"], 1_500)
      : null;
    return {
      ...emptyDockerEnvironment(),
      composeCommand: legacyCompose?.exitCode === 0 ? "docker-compose" : null,
      composeVersion:
        legacyCompose?.exitCode === 0 ? cleanProbeOutput(legacyCompose.output) : null,
    };
  }

  const [client, server, context, compose] = await Promise.all([
    probe("docker", ["--version"], 1_500),
    probe(
      "docker",
      [
        "info",
        "--format",
        "{{.ServerVersion}}\t{{.OSType}}\t{{.Architecture}}",
      ],
      2_000,
    ),
    probe("docker", ["context", "show"], 1_500),
    probe("docker", ["compose", "version", "--short"], 1_500),
  ]);
  const legacyCompose =
    compose.exitCode !== 0 && legacyComposeInstalled
      ? await probe("docker-compose", ["version", "--short"], 1_500)
      : null;
  const [serverVersion, osType, architecture] =
    server.exitCode === 0
      ? cleanProbeOutput(server.output).split("\t", 3)
      : [];
  const composeResult =
    compose.exitCode === 0
      ? { command: "docker compose" as const, result: compose }
      : legacyCompose?.exitCode === 0
        ? { command: "docker-compose" as const, result: legacyCompose }
        : null;

  return {
    installed: true,
    clientVersion:
      client.exitCode === 0 ? cleanProbeOutput(client.output) : null,
    daemonAvailable: server.exitCode === 0,
    serverVersion: serverVersion || null,
    osType: osType || null,
    architecture: architecture || null,
    context: context.exitCode === 0 ? cleanProbeOutput(context.output) : null,
    composeCommand: composeResult?.command ?? null,
    composeVersion: composeResult
      ? cleanProbeOutput(composeResult.result.output)
      : null,
  };
}

export function inventoryEnvironmentVariables(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | string,
): Pick<
  ToolEnvironment,
  "environmentVariableNames" | "toolingEnvironmentVariables" | "pathEntries"
> {
  const environmentVariableNames = Object.keys(environment).sort(
    (left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
  const toolingEnvironmentVariables = Object.fromEntries(
    TOOLING_ENVIRONMENT_VARIABLES.flatMap((name) => {
      const value = environmentValue(environment, name, platform);
      return value ? [[name, value]] : [];
    }),
  );
  const rawPath = environmentValue(environment, "PATH", platform) ?? "";
  const separator = platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const pathEntries = rawPath
    .split(separator)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => {
      if (!entry) return false;
      const key = platform === "win32" ? entry.toLowerCase() : entry;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return {
    environmentVariableNames,
    toolingEnvironmentVariables,
    pathEntries,
  };
}

async function detectCommands(): Promise<{
  commands: Record<string, boolean>;
  commandPaths: Record<string, string[]>;
}> {
  const entries = await Promise.all(
    COMMANDS_TO_PROBE.map(
      async (command) => [command, await findCommandPaths(command)] as const,
    ),
  );
  return {
    commands: Object.fromEntries(
      entries.map(([command, paths]) => [command, paths.length > 0]),
    ),
    commandPaths: Object.fromEntries(
      entries.map(([command, paths]) => [command, paths]),
    ),
  };
}

async function findCommandPaths(command: string): Promise<string[]> {
  const lookup =
    process.platform === "win32"
      ? `where.exe ${quoteForShell(command)}`
      : `command -v ${quoteForShell(command)}`;

  return new Promise((resolve) => {
    const child = spawn(lookup, { shell: true, windowsHide: true });
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill();
      resolve([]);
    }, 2_000);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length < 64_000) stdout += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve([]);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        resolve([]);
        return;
      }
      resolve([
        ...new Set(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      ]);
    });
  });
}

function runCommandProbe(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, output });
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (output.length < 16_000) output += chunk.toString();
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

function emptyDockerEnvironment(): DockerEnvironment {
  return {
    installed: false,
    clientVersion: null,
    daemonAvailable: false,
    serverVersion: null,
    osType: null,
    architecture: null,
    context: null,
    composeCommand: null,
    composeVersion: null,
  };
}

function cleanProbeOutput(output: string): string {
  return output.trim().replace(/\r?\n/g, " ");
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform | string,
): string | undefined {
  if (platform !== "win32") return environment[name];
  const key = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? environment[key] : undefined;
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
