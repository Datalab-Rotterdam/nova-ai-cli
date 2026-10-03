import type * as acp from "@agentclientprotocol/sdk";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolHost } from "../tool-host.js";
import { resolveReplacement } from "./edit-file.js";
import { resolveWorkspaceFile } from "./workspace-paths.js";

const MAX_TITLE_COMMAND_CHARS = 80;

/** Human-readable title and file locations of a tool call, as ACP clients show them. */
export function describeToolCall(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): { title: string; locations: acp.ToolCallLocation[] } {
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
  const path = str("path");
  const shown = path ? displayPath(path, cwd) : "";
  const locations = path ? [{ path: resolve(cwd, path) }] : [];
  switch (name) {
    case "run_command":
    case "start_background_command":
      return { title: `Run \`${clip(str("command"))}\``, locations: [] };
    case "run_package_script":
      return { title: `Run npm script ${str("script")}`, locations: [] };
    case "write_file":
      return { title: `Write ${shown}`, locations };
    case "edit_file":
      return { title: `Edit ${shown}`, locations };
    case "read_file":
      return { title: `Read ${shown}`, locations };
    case "list_directory":
      return { title: `List ${shown || "."}`, locations };
    case "search_text":
      return { title: `Search for "${clip(str("query") || str("pattern"))}"`, locations };
    case "memory_write":
      return { title: `Update ${str("scope") || "project"} memory`, locations: [] };
    case "memory_read":
      return { title: "Read memory", locations: [] };
    default:
      return { title: name, locations: [] };
  }
}

/**
 * What the user should see before approving: the exact diff for file writes
 * and edits (computed with the tool's own logic, so it is what will be
 * written) and the command line for shell tools. Never throws.
 */
export async function previewToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: { host: ToolHost; cwd: string; signal: AbortSignal },
): Promise<acp.ToolCallContent[]> {
  try {
    if (name === "run_command" || name === "start_background_command") {
      const command = typeof args.command === "string" ? args.command : "";
      return command ? [text(`\`\`\`sh\n${command}\n\`\`\``)] : [];
    }
    if (name !== "write_file" && name !== "edit_file") return [];
    const resolved = await resolveWorkspaceFile(ctx.cwd, args.path);
    if ("error" in resolved) return [];
    let oldText: string | null = null;
    try {
      oldText = await ctx.host.readTextFile(resolved.path, ctx.signal);
    } catch {
      oldText = null;
    }
    if (name === "write_file") {
      const content = typeof args.content === "string" ? args.content : "";
      return [{ type: "diff", path: resolved.path, oldText, newText: content }];
    }
    if (oldText === null) return [];
    const replacement = resolveReplacement(
      oldText,
      typeof args.old_string === "string" ? args.old_string : "",
      typeof args.new_string === "string" ? args.new_string : "",
      args.replace_all === true,
      resolved.path,
    );
    if ("error" in replacement) return [];
    return [{ type: "diff", path: resolved.path, oldText, newText: replacement.newContent }];
  } catch {
    return [];
  }
}

function text(value: string): acp.ToolCallContent {
  return { type: "content", content: { type: "text", text: value } };
}

function displayPath(path: string, cwd: string): string {
  const rel = relative(resolve(cwd), resolve(cwd, path));
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : path;
}

function clip(value: string): string {
  const single = value.replace(/\s+/g, " ");
  return single.length > MAX_TITLE_COMMAND_CHARS ? `${single.slice(0, MAX_TITLE_COMMAND_CHARS)}…` : single;
}

/** ACP kind of a tool by name, for calls replayed from history. */
const TOOL_KINDS: Record<string, acp.ToolKind> = {
  read_file: "read",
  list_directory: "search",
  search_text: "search",
  inspect_environment: "read",
  load_skill: "read",
  memory_read: "read",
  load_memory: "read",
  list_background_jobs: "read",
  read_background_output: "read",
  wait_for_background_jobs: "think",
  ask_user: "think",
  update_plan: "think",
  enter_plan_mode: "switch_mode",
  write_file: "edit",
  edit_file: "edit",
  memory_write: "edit",
  save_memory: "edit",
  run_command: "execute",
  run_package_script: "execute",
  start_background_command: "execute",
  start_background_agent: "think",
  kill_background_job: "execute",
  release_background_job: "execute",
};

export function toolKindOf(name: string): acp.ToolKind {
  return TOOL_KINDS[name] ?? "other";
}
