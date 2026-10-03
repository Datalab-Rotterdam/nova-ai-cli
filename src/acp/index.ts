import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { NovaAgent } from "./agent.js";
import { createAgentApp } from "./server.js";
import { redirectConsoleToStderr } from "./stdio-guard.js";

async function runAcp(...args: string[]): Promise<void> {
  redirectConsoleToStderr();
  const agentImpl = new NovaAgent();

  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, input);

  const connection = createAgentApp(agentImpl).connect(stream);

  installLifecycle(agentImpl, connection.closed);
  await connection.closed;
}

/**
 * The editor owns this process: when it closes stdin or signals us, cancel
 * running turns (they save their history), stop background agents and MCP
 * servers, and exit. A second signal exits immediately.
 */
function installLifecycle(agent: NovaAgent, closed: Promise<void>): void {
  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) process.exit(code);
    shuttingDown = true;
    const forced = setTimeout(() => process.exit(code), SHUTDOWN_TIMEOUT_MS);
    forced.unref();
    try {
      await agent.shutdown();
    } catch (error) {
      console.error("nova-ai-cli: error during shutdown:", error);
    }
    process.exit(code);
  };
  void closed.then(() => shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(130));
  process.on("unhandledRejection", (reason) => {
    // stderr only: stdout belongs to the JSON-RPC stream.
    console.error("nova-ai-cli: unhandled rejection:", reason);
  });
}

const SHUTDOWN_TIMEOUT_MS = 5_000;


export default runAcp;
