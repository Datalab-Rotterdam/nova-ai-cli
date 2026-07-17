import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { PermissionMode } from "../state/types.js";
import type { PermissionRuleSet } from "./permission-rules.js";

export type WorkspaceSettings = {
  permissionMode?: PermissionMode;
  permissions?: PermissionRuleSet;
  /** MCP servers forwarded unchanged to ACP when a TUI session starts. */
  mcpServers?: McpServer[];
};

function settingsPath(cwd: string): string {
  return join(cwd, ".nova-ai", "settings.json");
}

export function readWorkspaceSettings(cwd: string): WorkspaceSettings {
  try {
    const raw = readFileSync(settingsPath(cwd), "utf8");
    return JSON.parse(raw) as WorkspaceSettings;
  } catch {
    return {};
  }
}

export function writeWorkspaceSettings(cwd: string, settings: WorkspaceSettings): void {
  const path = settingsPath(cwd);
  mkdirSync(join(cwd, ".nova-ai"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export function addAllowedPermissionRule(cwd: string, rule: string): void {
  const current = readWorkspaceSettings(cwd);
  const allow = new Set(current.permissions?.allow ?? []);
  allow.add(rule);
  writeWorkspaceSettings(cwd, {
    ...current,
    permissions: { ...current.permissions, allow: [...allow] },
  });
}

export function setPermissionMode(cwd: string, permissionMode: PermissionMode): void {
  const current = readWorkspaceSettings(cwd);
  writeWorkspaceSettings(cwd, { ...current, permissionMode });
}
