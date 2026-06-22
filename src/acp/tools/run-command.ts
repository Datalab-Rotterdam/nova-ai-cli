import * as acp from "@agentclientprotocol/sdk";
import type { ToolDefinition } from "./types.js";

export const runCommandTool: ToolDefinition = {
  name: "run_command",
  description:
    'run_command: {"command": "<shell command>"} — run a shell command in the workspace and return its output.',
  requiredCapability: (caps) => !!caps?.terminal,
  mutating: true,
  async execute({ client, sessionId, signal }, args) {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command) return { error: "run_command requires a 'command' argument." };

    let terminalId: string | undefined;
    try {
      const created = await client.request(
        acp.methods.client.terminal.create,
        { sessionId, command },
        { cancellationSignal: signal },
      );
      terminalId = created.terminalId;

      const exit = await client.request(
        acp.methods.client.terminal.waitForExit,
        { sessionId, terminalId },
        { cancellationSignal: signal },
      );
      const { output, truncated } = await client.request(
        acp.methods.client.terminal.output,
        { sessionId, terminalId },
        { cancellationSignal: signal },
      );

      const exitNote = exit.exitCode !== undefined && exit.exitCode !== null ? ` (exit code ${exit.exitCode})` : "";
      return { output: `${output}${truncated ? "\n[output truncated]" : ""}${exitNote}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to run command." };
    } finally {
      if (terminalId) {
        void client.request(acp.methods.client.terminal.release, { sessionId, terminalId }).catch(() => {});
      }
    }
  },
};
