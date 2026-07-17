import type { PackageManager } from "./environment.js";
import type { ToolDefinition } from "./types.js";

export const runPackageScriptTool: ToolDefinition = {
  name: "run_package_script",
  description:
    'run_package_script: {"script": "<package.json script name>", "args": ["optional", "args"]} - run a detected package.json script with npm, pnpm, or yarn in the workspace. Requires permission.',
  isAvailable: ({ caps, environment }) =>
    !!caps?.terminal && !!environment?.packageManager && environment.packageScripts.length > 0,
  mutating: true,
  kind: "execute",
  async execute({ host, signal, environment }, args) {
    const script = typeof args.script === "string" ? args.script : "";
    if (!script) return { error: "run_package_script requires a 'script' argument." };
    if (!environment.packageManager) return { error: "No package manager is available for this workspace." };
    if (!environment.packageScripts.includes(script)) {
      return {
        error: `Unknown package script "${script}". Available scripts: ${
          environment.packageScripts.length ? environment.packageScripts.join(", ") : "none"
        }`,
      };
    }

    const extraArgs = Array.isArray(args.args) ? args.args.filter((arg): arg is string => typeof arg === "string") : [];
    const command = buildPackageScriptCommand(environment.packageManager, script, extraArgs, environment.platform);

    try {
      const { output, truncated, exitCode } = await host.runCommand(command, signal);
      const exitNote = exitCode !== null ? ` (exit code ${exitCode})` : "";
      return { output: `${output}${truncated ? "\n[output truncated]" : ""}${exitNote}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to run package script." };
    }
  },
};

export function buildPackageScriptCommand(
  packageManager: PackageManager,
  script: string,
  args: string[],
  platform: NodeJS.Platform | string,
): string {
  const quote = (value: string) => quoteShellArg(value, platform);
  const quotedArgs = args.map(quote);

  if (packageManager === "yarn") {
    return ["yarn", "run", quote(script), ...quotedArgs].join(" ");
  }

  return [packageManager, "run", quote(script), ...(quotedArgs.length ? ["--", ...quotedArgs] : [])].join(" ");
}

function quoteShellArg(value: string, platform: NodeJS.Platform | string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  if (platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
