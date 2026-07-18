import type { ToolDefinition } from "./types.js";

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "overwrite a text file in the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "absolute path" },
      content: { type: "string", description: "full file content" },
    },
    required: ["path", "content"],
  },
  requiredCapability: (caps) => !!caps?.fs?.writeTextFile,
  mutating: true,
  kind: "edit",
  async execute({ host, signal }, args) {
    const path = typeof args.path === "string" ? args.path : "";
    const content = typeof args.content === "string" ? args.content : "";
    if (!path) return { error: "write_file requires a 'path' argument." };

    let oldText: string | null = null;
    try {
      oldText = await host.readTextFile(path, signal);
    } catch {
      oldText = null;
    }

    try {
      await host.writeTextFile(path, content, signal);
      return { output: `Wrote ${content.length} characters to ${path}.`, diff: { path, oldText, newText: content } };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to write file." };
    }
  },
};
