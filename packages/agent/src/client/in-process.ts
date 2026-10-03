import * as acp from "@agentclientprotocol/sdk";
import { NovaAgent } from "../acp/agent.js";
import { createAgentApp } from "../acp/server.js";
import { NovaAgentClient } from "./nova-agent-client.js";

export type InProcessAgent = {
  /** The agent behind the connection (tests may inspect or stub it). */
  agent: NovaAgent;
  client: NovaAgentClient;
  /** Closes the connection and shuts the agent down. */
  close(): Promise<void>;
};

/**
 * Runs the agent in this process and talks to it over ACP exactly like an
 * editor does: every message is serialized to NDJSON, validated and routed
 * through the same handlers as `nova-ai --acp`, so the TUI and headless runner
 * cannot depend on anything an external client could not do.
 */
export function startInProcessAgent(
  toClient: (agent: acp.Agent) => acp.Client,
  agent = new NovaAgent(),
): InProcessAgent {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClientStream = new TransformStream<Uint8Array, Uint8Array>();
  const agentConnection = createAgentApp(agent).connect(
    acp.ndJsonStream(toClientStream.writable, toAgent.readable),
  );
  const connection = new acp.ClientSideConnection(
    toClient,
    acp.ndJsonStream(toAgent.writable, toClientStream.readable),
  );
  return {
    agent,
    client: new NovaAgentClient(connection),
    async close() {
      await agent.shutdown().catch(() => {});
      agentConnection.close();
    },
  };
}
