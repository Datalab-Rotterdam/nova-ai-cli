import * as acp from "@agentclientprotocol/sdk";
import type { RunCommandResult, ToolHost } from "../core/tool-host.js";

export class AcpToolHost implements ToolHost {
  constructor(
    private readonly client: acp.AgentContext,
    private readonly sessionId: string,
  ) {}

  async readTextFile(path: string, signal: AbortSignal): Promise<string> {
    const result = await this.client.request(
      acp.methods.client.fs.readTextFile,
      { sessionId: this.sessionId, path },
      { cancellationSignal: signal },
    );
    return result.content;
  }

  async writeTextFile(path: string, content: string, signal: AbortSignal): Promise<void> {
    await this.client.request(
      acp.methods.client.fs.writeTextFile,
      { sessionId: this.sessionId, path, content },
      { cancellationSignal: signal },
    );
  }

  async runCommand(command: string, signal: AbortSignal): Promise<RunCommandResult> {
    const sessionId = this.sessionId;
    let terminalId: string | undefined;
    try {
      const created = await this.client.request(
        acp.methods.client.terminal.create,
        { sessionId, command },
        { cancellationSignal: signal },
      );
      terminalId = created.terminalId;

      const exit = await this.client.request(
        acp.methods.client.terminal.waitForExit,
        { sessionId, terminalId },
        { cancellationSignal: signal },
      );
      const { output, truncated } = await this.client.request(
        acp.methods.client.terminal.output,
        { sessionId, terminalId },
        { cancellationSignal: signal },
      );

      return { output, truncated, exitCode: exit.exitCode ?? null };
    } finally {
      if (terminalId) {
        void this.client.request(acp.methods.client.terminal.release, { sessionId, terminalId }).catch(() => {});
      }
    }
  }
}
