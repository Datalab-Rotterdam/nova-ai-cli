import {
  MAX_COMMAND_TIMEOUT_MS,
  type RunCommandResult,
} from "../tool-host.js";
import type { ToolDefinition } from "./types.js";

export const runCommandTool: ToolDefinition = {
  name: "run_command",
  description:
    "run a non-interactive shell command in the workspace and return its output. Commands that do not finish within timeout_seconds (default 120, at most 600) are stopped; start servers and watchers with start_background_command instead.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "shell command" },
      timeout_seconds: {
        type: "integer",
        description: "stop the command after this many seconds (default 120, max 600)",
      },
    },
    required: ["command"],
  },
  requiredCapability: (caps) => !!caps?.terminal,
  mutating: true,
  kind: "execute",
  async execute({ host, signal, cwd, toolCallId }, args) {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command) return { error: "run_command requires a 'command' argument." };

    try {
      const result = await host.runCommand(command, signal, {
        cwd,
        toolCallId,
        timeoutMs: commandTimeoutMs(args.timeout_seconds),
      });
      return { output: formatCommandResult(result) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to run command." };
    }
  },
};

/** The model's timeout_seconds, capped; undefined lets the host use the session's default. */
export function commandTimeoutMs(seconds: unknown): number | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return Math.min(Math.round(seconds * 1000), MAX_COMMAND_TIMEOUT_MS);
}

export function formatCommandResult(result: RunCommandResult): string {
  const notes = [
    result.truncated ? "\n[output truncated]" : "",
    result.timedOut ? "\n[timed out: the command was stopped]" : "",
    result.exitCode !== null ? ` (exit code ${result.exitCode})` : "",
  ];
  return `${result.output}${notes.join("")}`;
}
