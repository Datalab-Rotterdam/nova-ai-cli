import type { ToolDefinition } from "./types.js";
import { resolveWorkspaceFile } from "./workspace-paths.js";

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "read a text file in the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "path inside the workspace (absolute or relative to the workspace root)" },
    },
    required: ["path"],
  },
  requiredCapability: (caps) => !!caps?.fs?.readTextFile,
  mutating: false,
  kind: "read",
  async execute({ host, cwd, signal }, args) {
    if (typeof args.path !== "string" || !args.path) {
      return { error: "read_file requires a 'path' argument." };
    }
    const resolved = await resolveWorkspaceFile(cwd, args.path);
    if ("error" in resolved) return resolved;
    const { path } = resolved;

    try {
      const content = await host.readTextFile(path, signal);
      return { output: content };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to read file.";
      return { error: `${message} (path tried: ${path})` };
    }
  },
};
