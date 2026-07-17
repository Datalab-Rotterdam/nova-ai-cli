import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { readWorkspaceSettings } from "./workspace-settings.js";

export type McpConfigurationFailure = {
  serverName: string;
  message: string;
};

export type WorkspaceMcpConfiguration = {
  servers: acp.McpServer[];
  failures: McpConfigurationFailure[];
};

export function readWorkspaceMcpConfiguration(cwd: string): WorkspaceMcpConfiguration {
  const configured = readWorkspaceSettings(cwd).mcpServers ?? [];
  const project = readProjectMcpConfiguration(cwd);
  const servers = new Map(configured.map((server) => [server.name, server]));
  for (const server of project.servers) servers.set(server.name, server);
  return { servers: [...servers.values()], failures: project.failures };
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
