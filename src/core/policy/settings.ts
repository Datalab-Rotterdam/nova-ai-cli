import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  isWorkspaceTrusted,
  novaHomeRoot,
  projectPaths,
  writePrivateFile,
} from "../nova-home.js";
import type { PermissionRuleSet } from "./rules.js";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";
export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && PERMISSION_MODES.includes(value as PermissionMode);
}

/**
 * Shape of every Nova settings file (docs/NOVA_HOME.md, "Settings"); unknown
 * keys are preserved by writers.
 */
export type NovaSettings = {
  permissions?: PermissionRuleSet;
  permissionMode?: string;
  [key: string]: unknown;
};

export type SettingsSource = {
  kind: "user" | "project-private" | "workspace" | "workspace-local";
  path: string;
  /** Allow rules from repository files only count in a trusted workspace. */
  allowApplies: boolean;
};

export function settingsSources(cwd: string): SettingsSource[] {
  const trusted = isWorkspaceTrusted(cwd);
  const workspace = join(resolve(cwd), ".nova-ai");
  return [
    { kind: "user", path: join(novaHomeRoot(), "settings.json"), allowApplies: true },
    { kind: "project-private", path: projectPaths(cwd).settings, allowApplies: true },
    { kind: "workspace", path: join(workspace, "settings.json"), allowApplies: trusted },
    { kind: "workspace-local", path: join(workspace, "settings.local.json"), allowApplies: trusted },
  ];
}

/** Effective rules: every deny rule; allow rules from trusted sources only. */
export function loadPermissionRules(cwd: string): { allow: string[]; deny: string[] } {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const source of settingsSources(cwd)) {
    const settings = readSettings(source.path);
    deny.push(...stringList(settings?.permissions?.deny));
    if (source.allowApplies) allow.push(...stringList(settings?.permissions?.allow));
  }
  return { allow, deny };
}

/** Adds a rule to the private per-project settings (outside the repository). */
export function addPrivateRule(cwd: string, kind: "allow" | "deny", rule: string): string {
  const path = projectPaths(cwd).settings;
  const settings = readSettings(path) ?? {};
  const permissions = settings.permissions ?? {};
  const list = stringList(permissions[kind]);
  if (!list.includes(rule)) list.push(rule);
  writePrivateFile(
    path,
    `${JSON.stringify({ ...settings, permissions: { ...permissions, [kind]: list } }, null, 2)}\n`,
  );
  return path;
}

/**
 * The remembered mode for this workspace. Only the user's own files count (a
 * repository cannot pick its own mode), and bypassPermissions is never
 * restored from disk: it must be chosen again in each session.
 */
export function savedPermissionMode(cwd: string): PermissionMode {
  for (const path of [projectPaths(cwd).settings, join(novaHomeRoot(), "settings.json")]) {
    const mode = readSettings(path)?.permissionMode;
    if (mode === "default" || mode === "acceptEdits") return mode;
  }
  return "default";
}

export function savePermissionMode(cwd: string, mode: PermissionMode): void {
  if (mode === "bypassPermissions") return;
  const path = projectPaths(cwd).settings;
  const settings = readSettings(path) ?? {};
  if (settings.permissionMode === mode) return;
  writePrivateFile(path, `${JSON.stringify({ ...settings, permissionMode: mode }, null, 2)}\n`);
}

export function readSettings(path: string): NovaSettings | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as NovaSettings)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
