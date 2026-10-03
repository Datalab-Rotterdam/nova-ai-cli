import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { PermissionRuleSet } from "../../core/policy/rules.js";

/**
 * The parts of `<workspace>/.nova-ai/settings.json` the TUI reads itself.
 * Permission rules and modes are the agent's (core/policy); this file is
 * committed with the repository, so nothing in it can switch approvals off.
 */
export type WorkspaceSettings = {
  permissions?: PermissionRuleSet;
  /** MCP servers forwarded to ACP when a TUI session starts (trusted workspaces only). */
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
