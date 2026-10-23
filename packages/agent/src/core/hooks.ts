import { resolve } from "node:path";
import { killProcessTree, spawnCommand } from "./process-tree.js";
import { readSettings, settingsSources } from "./policy/settings.js";

/**
 * Hooks in Claude Code's format, from the same settings files as the
 * permission rules (docs/NOVA_HOME.md, "Hooks"), with the VS Code
 * extension's semantics:
 *
 * ```json
 * { "hooks": { "PreToolUse": [{ "matcher": "run_command|Bash", "hooks": [{ "type": "command", "command": "./check.sh", "timeout": 30 }] }] } }
 * ```
 *
 * A hook gets the event as JSON on stdin. Exit code 2 blocks (stderr says
 * why); exit 0 may print JSON (`decision`, `reason`, `hookSpecificOutput`);
 * any other exit code is a warning.
 */
export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "SessionStart";

export type HookOutcome = {
  /** Why a hook blocked: the tool call, the prompt, or stopping. */
  block?: string;
  /** A PreToolUse hook approved the call: no permission request (deny rules still win). */
  allow?: boolean;
  /** Text for the model: plain stdout of UserPromptSubmit/SessionStart hooks, or `additionalContext`. */
  context?: string;
  /** Hooks that failed without blocking, for the user. */
  warnings: string[];
};

/** How often a Stop hook may send the agent back to work in one turn. */
export const MAX_STOP_HOOK_ROUNDS = 3;

const DEFAULT_TIMEOUT_SECONDS = 60;
const OUTPUT_LIMIT = 64_000;

/** Claude Code's tool names, so hooks copied from `.claude/settings.json` match. */
const CLAUDE_NAMES: Record<string, string> = {
  run_command: "Bash",
  read_file: "Read",
  edit_file: "Edit",
  write_file: "Write",
  find_files: "Glob",
  search_text: "Grep",
  list_directory: "LS",
  fetch_url: "WebFetch",
  web_search: "WebSearch",
  update_plan: "TodoWrite",
};

type HookCommand = { command: string; timeout: number };

/**
 * Every settings file's hooks, per event. Like allow rules, a workspace's own
 * files only count in a trusted workspace: a hook runs any command.
 */
export function loadHooks(cwd: string): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {};
  for (const source of settingsSources(cwd)) {
    if (!source.allowApplies) continue;
    const hooks = readSettings(source.path)?.hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) continue;
    for (const [event, matchers] of Object.entries(hooks)) {
      if (Array.isArray(matchers)) (merged[event] ??= []).push(...matchers);
    }
  }
  return merged;
}

/** Runs the event's matching hooks in parallel (settings read fresh) and combines what they decided. */
export async function runHooks(
  event: HookEvent,
  payload: Record<string, unknown>,
  options: { cwd: string; sessionId: string; signal?: AbortSignal },
): Promise<HookOutcome> {
  const outcome: HookOutcome = { warnings: [] };
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
  const commands = matchingCommands(loadHooks(options.cwd), event, toolName);
  if (!commands.length) return outcome;
  const input = JSON.stringify({
    session_id: options.sessionId,
    ...payload,
    ...withClaudeFields(payload, options.cwd),
    hook_event_name: event,
    cwd: options.cwd,
  });
  const results = await Promise.all(
    commands.map(async (hook) => ({ hook, result: await runHookCommand(hook, input, options) })),
  );

  const blocks: string[] = [];
  const context: string[] = [];
  for (const { hook, result } of results) {
    if (result.cancelled) continue;
    if (result.timedOut) {
      outcome.warnings.push(`Hook "${hook.command}" timed out after ${hook.timeout}s.`);
    } else if (result.exitCode === 2) {
      blocks.push(result.stderr || `Blocked by hook "${hook.command}".`);
    } else if (result.exitCode !== 0) {
      outcome.warnings.push(
        `Hook "${hook.command}" failed (exit code ${result.exitCode})${result.stderr ? `: ${result.stderr}` : "."}`,
      );
    } else {
      const decision = parseDecision(result.stdout);
      if (decision) {
        if (decision.block !== undefined) blocks.push(decision.block || `Blocked by hook "${hook.command}".`);
        outcome.allow ||= decision.allow;
        if (decision.context) context.push(decision.context);
      } else if (result.stdout && (event === "UserPromptSubmit" || event === "SessionStart")) {
        context.push(result.stdout);
      }
    }
  }
  if (blocks.length) {
    outcome.block = blocks.join("\n");
    outcome.allow = false;
  }
  if (context.length) outcome.context = context.join("\n");
  return outcome;
}

/** The commands of the event's matchers that match the tool (matchers only apply to tool events). */
export function matchingCommands(
  config: Record<string, unknown[]>,
  event: HookEvent,
  toolName?: string,
): HookCommand[] {
  const names = toolName ? [toolName, CLAUDE_NAMES[toolName]].filter((name): name is string => !!name) : [];
  return (config[event] ?? []).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { matcher, hooks } = entry as { matcher?: unknown; hooks?: unknown };
    if (toolName && typeof matcher === "string" && matcher && matcher !== "*" && !names.some((name) => matches(matcher, name))) {
      return [];
    }
    return (Array.isArray(hooks) ? hooks : []).flatMap((hook): HookCommand[] => {
      const { type, command, timeout } = (hook ?? {}) as { type?: unknown; command?: unknown; timeout?: unknown };
      return (type === undefined || type === "command") && typeof command === "string" && command.trim()
        ? [{ command, timeout: typeof timeout === "number" && timeout > 0 ? timeout : DEFAULT_TIMEOUT_SECONDS }]
        : [];
    });
  });
}

/** A matcher is a regular expression over the whole tool name (`Edit|Write`, `mcp__github__.*`). */
function matches(matcher: string, name: string): boolean {
  try {
    return new RegExp(`^(?:${matcher})$`).test(name);
  } catch {
    return matcher === name;
  }
}

/** What Claude Code hooks expect besides Nova's own fields: an absolute `file_path`. */
function withClaudeFields(payload: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const input = payload.tool_input as Record<string, unknown> | undefined;
  if (input && typeof input.path === "string" && input.file_path === undefined) {
    return { tool_input: { ...input, file_path: resolve(cwd, input.path) } };
  }
  return {};
}

/** The decision in a hook's JSON output, if it printed JSON. */
export function parseDecision(stdout: string): { block?: string; allow?: boolean; context?: string } | undefined {
  if (!stdout.startsWith("{")) return undefined;
  let output: Record<string, unknown>;
  try {
    output = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const specific = (output.hookSpecificOutput ?? {}) as Record<string, unknown>;
  const reason = typeof output.reason === "string" ? output.reason : undefined;
  const permissionReason =
    typeof specific.permissionDecisionReason === "string" ? specific.permissionDecisionReason : reason;
  const blocked = output.decision === "block" || specific.permissionDecision === "deny" || output.continue === false;
  const stopReason = typeof output.stopReason === "string" ? output.stopReason : undefined;
  return {
    ...(blocked
      ? { block: (output.decision === "block" ? reason : output.continue === false ? stopReason : permissionReason) ?? "" }
      : {}),
    allow: output.decision === "approve" || specific.permissionDecision === "allow",
    context: typeof specific.additionalContext === "string" ? specific.additionalContext : undefined,
  };
}

type HookRun = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean };

/** One hook in the workspace root, in its own process group; the whole tree is stopped on timeout or cancel. */
function runHookCommand(
  hook: HookCommand,
  input: string,
  options: { cwd: string; signal?: AbortSignal },
): Promise<HookRun> {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let child: ReturnType<typeof spawnCommand>;
    try {
      child = spawnCommand(hook.command, {
        cwd: options.cwd,
        env: { ...process.env, NOVA_PROJECT_DIR: options.cwd, CLAUDE_PROJECT_DIR: options.cwd },
        stdin: true,
      });
    } catch (error) {
      done({ exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false, cancelled: false });
      return;
    }
    const stop = () => killProcessTree(child, "SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, hook.timeout * 1_000);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => (stdout = (stdout + chunk.toString("utf8")).slice(0, OUTPUT_LIMIT)));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(0, OUTPUT_LIMIT)));
    // A hook that ignores stdin closes it early; that must not crash the agent.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    const finish = (exitCode: number | null, error?: Error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      done({
        exitCode,
        stdout: stdout.trim(),
        stderr: (stderr || error?.message || "").trim(),
        timedOut,
        cancelled: cancelled || !!options.signal?.aborted,
      });
    };
    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code));
  });
}
