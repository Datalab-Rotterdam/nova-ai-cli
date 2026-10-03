import type { ToolDefinition } from "./types.js";

export const runCommandTool: ToolDefinition = {
  name: "run_command",
  description: "run a shell command in the workspace and return its output.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "shell command" },
    },
    required: ["command"],
  },
  requiredCapability: (caps) => !!caps?.terminal,
  mutating: true,
  kind: "execute",
  async execute({ host, signal }, args) {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command) return { error: "run_command requires a 'command' argument." };

    try {
      const { output, truncated, exitCode } = await host.runCommand(command, signal);
      const exitNote = exitCode !== null ? ` (exit code ${exitCode})` : "";
      return { output: `${output}${truncated ? "\n[output truncated]" : ""}${exitNote}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to run command." };
    }
  },
};
