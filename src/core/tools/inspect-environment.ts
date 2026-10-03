import type { ToolDefinition } from "./types.js";

export const inspectEnvironmentTool: ToolDefinition = {
  name: "inspect_environment",
  description:
    "report OS/platform, safe environment-variable inventory, PATH entries, resolved command paths, Docker/Compose usability, ACP client capabilities, package manager, package scripts, and tool availability notes.",
  parameters: { type: "object", properties: {} },
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
    const resolvedCommands = availableCommands.flatMap((command) => {
      const paths = environment.commandPaths[command] ?? [];
      return paths.length ? [`  ${command}: ${paths.join(", ")}`] : [];
    });
    const toolingEnvironment = Object.entries(
      environment.toolingEnvironmentVariables,
    ).map(([name, value]) => `  ${name}=${value}`);
    const pathEntries = environment.pathEntries.map(
      (entry, index) => `  ${index + 1}. ${entry}`,
    );
    const dockerPlatform = [
      environment.docker.osType,
      environment.docker.architecture,
    ]
      .filter(Boolean)
      .join("/");
    const containerExecutionAvailable =
      environment.docker.daemonAvailable &&
      !!environment.clientCapabilities?.terminal;

    const lines = [
      `Platform: ${environment.platform}`,
      `Workspace readable: ${environment.workspaceReadable ? "yes" : "no"}`,
      `ACP filesystem: read=${environment.clientCapabilities?.fs?.readTextFile ? "yes" : "no"}, write=${environment.clientCapabilities?.fs?.writeTextFile ? "yes" : "no"}`,
      `ACP terminal: ${environment.clientCapabilities?.terminal ? "yes" : "no"}`,
      `Package manager: ${environment.packageManager ?? "none detected"}`,
      `Package scripts: ${environment.packageScripts.length ? environment.packageScripts.join(", ") : "none"}`,
      `Available commands: ${availableCommands.length ? availableCommands.join(", ") : "none detected"}`,
      `Missing commands: ${missingCommands.length ? missingCommands.join(", ") : "none detected"}`,
      `Resolved command paths:\n${resolvedCommands.length ? resolvedCommands.join("\n") : "  none detected"}`,
      `Environment variables (names only): ${environment.environmentVariableNames.length ? environment.environmentVariableNames.join(", ") : "none detected"}`,
      `Tooling environment variables:\n${toolingEnvironment.length ? toolingEnvironment.join("\n") : "  none detected"}`,
      `PATH entries (${environment.pathEntries.length}):\n${pathEntries.length ? pathEntries.join("\n") : "  none detected"}`,
      `Docker CLI: ${environment.docker.installed ? environment.docker.clientVersion ?? "detected" : "not detected"}`,
      `Docker daemon: ${environment.docker.daemonAvailable ? `available${environment.docker.serverVersion ? `; server=${environment.docker.serverVersion}` : ""}${dockerPlatform ? `; platform=${dockerPlatform}` : ""}` : "unavailable"}`,
      `Docker context: ${environment.docker.context ?? "unknown"}`,
      `Docker Compose: ${environment.docker.composeCommand ? `${environment.docker.composeCommand}${environment.docker.composeVersion ? ` ${environment.docker.composeVersion}` : ""}` : "not detected"}`,
      `Container execution: ${containerExecutionAvailable ? "available through run_command (permission required)" : "unavailable; requires ACP terminal support and a reachable Docker daemon"}`,
      `run_package_script: ${
        environment.clientCapabilities?.terminal &&
        environment.packageManager &&
        environment.packageScripts.length
          ? "available"
          : "unavailable; requires ACP terminal support, a package manager, and package.json scripts"
      }`,
    ];

    return { output: lines.join("\n") };
  },
};
