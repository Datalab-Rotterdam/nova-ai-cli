import type { ToolDefinition } from "./types.js";

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "read a text file in the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "absolute path" },
    },
    required: ["path"],
  },
  requiredCapability: (caps) => !!caps?.fs?.readTextFile,
  mutating: false,
  kind: "read",
  async execute({ host, signal }, args) {
    const path = typeof args.path === "string" ? args.path : "";
    if (!path) return { error: "read_file requires a 'path' argument." };

    try {
      const content = await host.readTextFile(path, signal);
      return { output: content };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to read file.";
      return { error: `${message} (path tried: ${path})` };
    }
  },
};
