// Manual smoke test for MCP server wiring in the ACP agent.
// Spawns the official filesystem MCP server over stdio, connects it to a
// fresh NovaAgent session, lists the tools it exposes, and calls one.
//
// Run: npx tsx examples/mcp-smoke-test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { NovaAgent } from "../src/acp/agent.js";

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "nova-mcp-smoke-"));
  writeFileSync(path.join(dir, "hello.txt"), "hello from mcp smoke test\n");

  const agent = new NovaAgent();

  agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

  const mcpServers: acp.McpServer[] = [
    {
      name: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", dir],
      env: [],
    },
  ];

  console.log(`Connecting MCP server, scoped to ${dir} ...`);
  const { sessionId } = await agent.newSession({ cwd: dir, mcpServers });
  console.log(`Session created: ${sessionId}`);

  // Reach into the private session map only for this smoke test, so we can
  // exercise listMcpTools()/callTool() without going through the full
  // chat-completion prompt loop (which needs Nova credentials).
  const session = (agent as unknown as { sessions: Map<string, { mcpTools: { name: string; execute: Function }[] }> }).sessions.get(
    sessionId,
  )!;

  console.log(
    "Tools exposed by the MCP server:",
    session.mcpTools.map((t) => t.name),
  );

  const readTool = session.mcpTools.find((t) => t.name.includes("read"));
  if (readTool) {
    const result = await readTool.execute(
      { client: undefined, sessionId, signal: new AbortController().signal },
      { path: path.join(dir, "hello.txt") },
    );
    console.log("Tool call result:", result);
  }

  await agent.closeSession({ sessionId });
  console.log("Session closed, MCP connections cleaned up.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
