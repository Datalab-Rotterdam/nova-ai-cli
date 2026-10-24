import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { OAUTH_META_KEY } from "./mcp-oauth.js";
import { isWorkspaceTrusted, novaHomeRoot } from "./nova-home.js";
import { readSettings } from "./policy/settings.js";

export type McpConfigurationFailure = {
  serverName: string;
  message: string;
};

export type WorkspaceMcpConfiguration = {
  servers: acp.McpServer[];
  failures: McpConfigurationFailure[];
  /** Servers the workspace declares that were not started because it is not trusted. */
  untrusted?: string[];
};

export const UNTRUSTED_MCP_MESSAGE =
  "Not started: MCP servers declared by this workspace only run once you trust it (/trust in the TUI, --trust-workspace headless).";

/**
 * MCP servers from the user's `~/.nova-ai/mcp.json` and those the workspace
 * declares (`mcpServers` in .nova-ai/settings.json, `.mcp.json`,
 * `.nova-ai/mcp.json`); a later source replaces a server of the same name,
 * as in the extension's `src/mcp/config.ts`. Declaring a stdio server means
 * running a command, so a cloned repository's servers only start in a
 * trusted workspace.
 */
export function readWorkspaceMcpConfiguration(
  cwd: string,
  options: { trusted?: boolean } = {},
): WorkspaceMcpConfiguration {
  const user = readMcpFile(join(novaHomeRoot(), "mcp.json"), "~/.nova-ai/mcp.json");
  const workspace = readDeclaredMcpConfiguration(cwd);
  const servers = new Map(user.servers.map((server) => [server.name, server]));
  const failures = [...user.failures, ...workspace.failures];
  if (workspace.servers.length && !(options.trusted ?? isWorkspaceTrusted(cwd))) {
    return {
      servers: [...servers.values()],
      failures: [
        ...failures,
        ...workspace.servers.map((server) => ({ serverName: server.name, message: UNTRUSTED_MCP_MESSAGE })),
      ],
      untrusted: workspace.servers.map((server) => server.name),
    };
  }
  for (const server of workspace.servers) servers.set(server.name, server);
  return { servers: [...servers.values()], failures };
}

/** Whether this workspace asks for anything that needs trust. */
export function workspaceNeedsTrust(cwd: string): boolean {
  if (isWorkspaceTrusted(cwd)) return false;
  if (readDeclaredMcpConfiguration(cwd).servers.length) return true;
  return loadWorkspaceAllowRules(cwd).length > 0;
}

/** The servers the workspace itself declares, in merge order. */
function readDeclaredMcpConfiguration(cwd: string): WorkspaceMcpConfiguration {
  const fromSettings = readSettings(join(cwd, ".nova-ai", "settings.json"))?.mcpServers;
  const configured = Array.isArray(fromSettings) ? (fromSettings as acp.McpServer[]) : [];
  const files = [
    readProjectMcpConfiguration(cwd),
    readMcpFile(join(cwd, ".nova-ai", "mcp.json"), ".nova-ai/mcp.json"),
  ];
  const servers = new Map(configured.map((server) => [server.name, server]));
  for (const file of files) for (const server of file.servers) servers.set(server.name, server);
  return { servers: [...servers.values()], failures: files.flatMap((file) => file.failures) };
}

function loadWorkspaceAllowRules(cwd: string): string[] {
  return ["settings.json", "settings.local.json"].flatMap((name) => {
    const allow = readSettings(join(cwd, ".nova-ai", name))?.permissions?.allow;
    return Array.isArray(allow) ? allow : [];
  });
}

export function readProjectMcpConfiguration(cwd: string): WorkspaceMcpConfiguration {
  return readMcpFile(join(cwd, ".mcp.json"), ".mcp.json");
}

/** One file in Claude's format (`{ "mcpServers": { … } }`); `label` names it in failures. */
function readMcpFile(path: string, label: string): WorkspaceMcpConfiguration {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: [], failures: [] };
    return { servers: [], failures: [{ serverName: label, message: errorMessage(error, "Could not read file") }] };
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return { servers: [], failures: [{ serverName: label, message: errorMessage(error, "Invalid JSON") }] };
  }

  const root = asRecord(document);
  const definitions = root ? asRecord(root.mcpServers) : null;
  if (!definitions) {
    return {
      servers: [],
      failures: [{ serverName: label, message: 'Expected an "mcpServers" object.' }],
    };
  }

  const servers: acp.McpServer[] = [];
  const failures: McpConfigurationFailure[] = [];
  for (const [name, value] of Object.entries(definitions)) {
    const config = asRecord(value);
    if (config?.disabled === true || config?.enabled === false) continue;
    try {
      servers.push(normalizeProjectServer(name, config));
    } catch (error) {
      failures.push({ serverName: `${label}:${name}`, message: errorMessage(error, "Invalid server configuration") });
    }
  }
  return { servers, failures };
}

function normalizeProjectServer(name: string, config: Record<string, unknown> | null): acp.McpServer {
  if (!config) throw new Error("Server definition must be an object.");
  const type = typeof config.type === "string" ? config.type : config.url ? "http" : "stdio";

  if (type === "http" || type === "sse") {
    if (typeof config.url !== "string" || !config.url) throw new Error(`${type} server requires a URL.`);
    const url = expand(config.url);
    try {
      new URL(url);
    } catch {
      throw new Error(`${type} server requires a valid URL.`);
    }
    const oauth = asRecord(config.oauth);
    return {
      name,
      type,
      url,
      headers: normalizePairs(config.headers, "headers"),
      ...(oauth ? { _meta: { [OAUTH_META_KEY]: oauth } } : {}),
    };
  }

  if (type !== "stdio") throw new Error(`Unsupported transport type: ${type}.`);
  if (typeof config.command !== "string" || !config.command) throw new Error("stdio server requires a command.");
  if (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every((arg) => typeof arg === "string"))) {
    throw new Error("args must be an array of strings.");
  }
  return {
    name,
    command: expand(config.command),
    args: ((config.args as string[] | undefined) ?? []).map((arg) => expand(arg)),
    env: normalizePairs(config.env, "env"),
  };
}

function normalizePairs(value: unknown, label: string): Array<{ name: string; value: string }> {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    if (!value.every((entry) => {
      const pair = asRecord(entry);
      return typeof pair?.name === "string" && typeof pair.value === "string";
    })) {
      throw new Error(`${label} must contain name/value strings.`);
    }
    return value.map((entry) => {
      const pair = entry as { name: string; value: string };
      return { name: pair.name, value: expand(pair.value) };
    });
  }

  const record = asRecord(value);
  if (!record || !Object.values(record).every((entry) => typeof entry === "string")) {
    throw new Error(`${label} must be an object of string values.`);
  }
  return Object.entries(record).map(([name, entry]) => ({ name, value: expand(entry as string) }));
}

/** `${VAR}` and `${VAR:-default}` from the environment, as in Claude's `.mcp.json` (and the extension). */
export function expand(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => env[name] ?? fallback ?? "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? `${fallback}: ${error.message}` : fallback;
}
