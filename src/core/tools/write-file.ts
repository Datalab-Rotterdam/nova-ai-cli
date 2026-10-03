import type { ToolDefinition } from "./types.js";
import { resolveWorkspaceFile } from "./workspace-paths.js";

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "overwrite a text file in the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "path inside the workspace (absolute or relative to the workspace root)" },
      content: { type: "string", description: "full file content" },
    },
    required: ["path", "content"],
  },
  requiredCapability: (caps) => !!caps?.fs?.writeTextFile,
  mutating: true,
  kind: "edit",
  async execute({ host, cwd, signal }, args) {
    const content = typeof args.content === "string" ? args.content : "";
    if (typeof args.path !== "string" || !args.path) {
      return { error: "write_file requires a 'path' argument." };
    }
    const resolved = await resolveWorkspaceFile(cwd, args.path);
    if ("error" in resolved) return resolved;
    const { path } = resolved;

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
