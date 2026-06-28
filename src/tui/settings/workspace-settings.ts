import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode } from "../state/types.js";

export type WorkspaceSettings = {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
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

export function addAlwaysAllowedTool(cwd: string, toolName: string): void {
  const current = readWorkspaceSettings(cwd);
  const allowedTools = new Set(current.allowedTools ?? []);
  allowedTools.add(toolName);
  writeWorkspaceSettings(cwd, { ...current, allowedTools: [...allowedTools] });
}

export function setPermissionMode(cwd: string, permissionMode: PermissionMode): void {
  const current = readWorkspaceSettings(cwd);
  writeWorkspaceSettings(cwd, { ...current, permissionMode });
}
