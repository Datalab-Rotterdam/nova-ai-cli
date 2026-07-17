import type { ToolDefinition } from "./types.js";

export const inspectEnvironmentTool: ToolDefinition = {
  name: "inspect_environment",
  description:
    "inspect_environment: {} - report OS/platform, ACP client capabilities, available commands, detected package manager, package scripts, and tool availability notes.",
  isAvailable: ({ caps, environment }) => !!caps?.fs?.readTextFile && !!environment?.workspaceReadable,
  mutating: false,
  kind: "read",
  async execute({ environment }) {
    const availableCommands = Object.entries(environment.commands)
      .filter(([, available]) => available)
      .map(([command]) => command)
      .sort();
    const missingCommands = Object.entries(environment.commands)
      .filter(([, available]) => !available)
      .map(([command]) => command)
      .sort();

    const lines = [
      `Platform: ${environment.platform}`,
      `Workspace readable: ${environment.workspaceReadable ? "yes" : "no"}`,
      `ACP filesystem: read=${environment.clientCapabilities?.fs?.readTextFile ? "yes" : "no"}, write=${environment.clientCapabilities?.fs?.writeTextFile ? "yes" : "no"}`,
      `ACP terminal: ${environment.clientCapabilities?.terminal ? "yes" : "no"}`,
      `Package manager: ${environment.packageManager ?? "none detected"}`,
      `Package scripts: ${environment.packageScripts.length ? environment.packageScripts.join(", ") : "none"}`,
      `Available commands: ${availableCommands.length ? availableCommands.join(", ") : "none detected"}`,
      `Missing commands: ${missingCommands.length ? missingCommands.join(", ") : "none detected"}`,
      `run_package_script: ${
        environment.clientCapabilities?.terminal && environment.packageManager && environment.packageScripts.length
          ? "available"
          : "unavailable; requires ACP terminal support, a package manager, and package.json scripts"
      }`,
    ];

    return { output: lines.join("\n") };
  },
};
