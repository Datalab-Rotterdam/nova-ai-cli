import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { isWorkspaceTrusted } from "../../core/nova-home.js";
import { readSettings } from "../../core/policy/settings.js";
import { readWorkspaceSettings } from "./workspace-settings.js";

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
 * MCP servers the workspace declares (`.mcp.json`, `mcpServers` in
 * .nova-ai/settings.json). Declaring a stdio server means running a command,
 * so a cloned repository's servers only start in a trusted workspace.
 */
export function readWorkspaceMcpConfiguration(
  cwd: string,
  options: { trusted?: boolean } = {},
): WorkspaceMcpConfiguration {
  const configured = readWorkspaceSettings(cwd).mcpServers ?? [];
  const project = readProjectMcpConfiguration(cwd);
  const servers = new Map(configured.map((server) => [server.name, server]));
  for (const server of project.servers) servers.set(server.name, server);
  const declared = [...servers.values()];
  if (declared.length && !(options.trusted ?? isWorkspaceTrusted(cwd))) {
    return {
      servers: [],
      failures: [
        ...project.failures,
        ...declared.map((server) => ({ serverName: server.name, message: UNTRUSTED_MCP_MESSAGE })),
      ],
      untrusted: declared.map((server) => server.name),
    };
  }
  return { servers: declared, failures: project.failures };
}

/** Whether this workspace asks for anything that needs trust. */
export function workspaceNeedsTrust(cwd: string): boolean {
  if (isWorkspaceTrusted(cwd)) return false;
  if (readWorkspaceMcpConfiguration(cwd, { trusted: true }).servers.length) return true;
  return loadWorkspaceAllowRules(cwd).length > 0;
}

function loadWorkspaceAllowRules(cwd: string): string[] {
  return ["settings.json", "settings.local.json"].flatMap((name) => {
    const allow = readSettings(join(cwd, ".nova-ai", name))?.permissions?.allow;
    return Array.isArray(allow) ? allow : [];
  });
}

export function readProjectMcpConfiguration(cwd: string): WorkspaceMcpConfiguration {
  const path = join(cwd, ".mcp.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: [], failures: [] };
    return { servers: [], failures: [{ serverName: ".mcp.json", message: errorMessage(error, "Could not read file") }] };
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return { servers: [], failures: [{ serverName: ".mcp.json", message: errorMessage(error, "Invalid JSON") }] };
  }

  const root = asRecord(document);
  const definitions = root ? asRecord(root.mcpServers) : null;
  if (!definitions) {
    return {
      servers: [],
      failures: [{ serverName: ".mcp.json", message: 'Expected an "mcpServers" object.' }],
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
      failures.push({ serverName: `.mcp.json:${name}`, message: errorMessage(error, "Invalid server configuration") });
    }
  }
  return { servers, failures };
}

function normalizeProjectServer(name: string, config: Record<string, unknown> | null): acp.McpServer {
  if (!config) throw new Error("Server definition must be an object.");
  const type = typeof config.type === "string" ? config.type : config.url ? "http" : "stdio";

  if (type === "http" || type === "sse") {
    if (typeof config.url !== "string" || !config.url) throw new Error(`${type} server requires a URL.`);
    try {
      new URL(config.url);
    } catch {
      throw new Error(`${type} server requires a valid URL.`);
    }
    return {
      name,
      type,
      url: config.url,
      headers: normalizePairs(config.headers, "headers"),
    };
  }

  if (type !== "stdio") throw new Error(`Unsupported transport type: ${type}.`);
  if (typeof config.command !== "string" || !config.command) throw new Error("stdio server requires a command.");
  if (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every((arg) => typeof arg === "string"))) {
    throw new Error("args must be an array of strings.");
  }
  return {
    name,
    command: config.command,
    args: (config.args as string[] | undefined) ?? [],
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
      return { name: pair.name, value: pair.value };
    });
  }

  const record = asRecord(value);
  if (!record || !Object.values(record).every((entry) => typeof entry === "string")) {
    throw new Error(`${label} must be an object of string values.`);
  }
  return Object.entries(record).map(([name, entry]) => ({ name, value: entry as string }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? `${fallback}: ${error.message}` : fallback;
}
