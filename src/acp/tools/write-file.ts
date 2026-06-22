import * as acp from "@agentclientprotocol/sdk";
import type { ToolDefinition } from "./types.js";

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    'write_file: {"path": "<absolute path>", "content": "<full file content>"} — overwrite a text file in the workspace.',
  requiredCapability: (caps) => !!caps?.fs?.writeTextFile,
  mutating: true,
  async execute({ client, sessionId, signal }, args) {
    const path = typeof args.path === "string" ? args.path : "";
    const content = typeof args.content === "string" ? args.content : "";
    if (!path) return { error: "write_file requires a 'path' argument." };

    try {
      await client.request(
        acp.methods.client.fs.writeTextFile,
        { sessionId, path, content },
        { cancellationSignal: signal },
      );
      return { output: `Wrote ${content.length} characters to ${path}.` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to write file." };
    }
  },
};
