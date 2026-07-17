import assert from "node:assert/strict";
import test from "node:test";
import { connectMcpServers, listMcpTools } from "../../src/acp/mcp.js";

test("MCP connection failures are returned as status instead of written to the terminal", async () => {
  const result = await connectMcpServers([{
    name: "missing-test-server",
    command: "nova-ai-definitely-missing-mcp-command",
    args: [],
    env: [],
  }]);

  assert.equal(result.connections.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.serverName, "missing-test-server");
  assert.ok(result.failures[0]?.message);
});

test("invalid MCP transport configuration is returned as a connection failure", async () => {
  const result = await connectMcpServers([{
    name: "invalid-url",
    type: "http",
    url: "not a URL",
    headers: [],
  }]);

  assert.equal(result.connections.length, 0);
  assert.equal(result.failures[0]?.serverName, "invalid-url");
  assert.match(result.failures[0]?.message ?? "", /Invalid URL/);
});

test("an MCP server that cannot list tools is closed and reported without failing the session", async () => {
  let closed = false;
  const result = await listMcpTools([{
    serverName: "broken-tools",
    client: { listTools: async () => { throw new Error("bad tool schema"); } } as never,
    close: async () => { closed = true; },
  }]);

  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.connections, []);
  assert.equal(closed, true);
  assert.deepEqual(result.failures, [{
    serverName: "broken-tools",
    message: "Could not list tools: bad tool schema",
  }]);
});
