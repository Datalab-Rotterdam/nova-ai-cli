import * as acp from "@agentclientprotocol/sdk";
import type { ToolDefinition } from "./types.js";

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: 'read_file: {"path": "<absolute path>"} — read a text file in the workspace.',
  requiredCapability: (caps) => !!caps?.fs?.readTextFile,
  mutating: false,
  async execute({ client, sessionId, signal }, args) {
    const path = typeof args.path === "string" ? args.path : "";
    if (!path) return { error: "read_file requires a 'path' argument." };

    try {
      const result = await client.request(
        acp.methods.client.fs.readTextFile,
        { sessionId, path },
        { cancellationSignal: signal },
      );
      return { output: result.content };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to read file.";
      return { error: `${message} (path tried: ${path})` };
    }
  },
};
