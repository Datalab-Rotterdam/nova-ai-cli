import assert from "node:assert/strict";
import test from "node:test";
import { connectMcpServers, listMcpTools } from "../../src/acp/mcp.js";

test("MCP connection failures are returned as status instead of written to the terminal", async () => {
  const result = await connectMcpServers([
    {
      name: "missing-test-server",
      command: "nova-ai-definitely-missing-mcp-command",
      args: [],
      env: [],
    },
  ]);

  assert.equal(result.connections.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.serverName, "missing-test-server");
  assert.ok(result.failures[0]?.message);
});

test("invalid MCP transport configuration is returned as a connection failure", async () => {
  const result = await connectMcpServers([
    {
      name: "invalid-url",
      type: "http",
      url: "not a URL",
      headers: [],
    },
  ]);

  assert.equal(result.connections.length, 0);
  assert.equal(result.failures[0]?.serverName, "invalid-url");
  assert.match(result.failures[0]?.message ?? "", /Invalid URL/);
});

test("an MCP server that cannot list tools is closed and reported without failing the session", async () => {
  let closed = false;
  const result = await listMcpTools([
    {
      serverName: "broken-tools",
      client: {
        listTools: async () => {
          throw new Error("bad tool schema");
        },
      } as never,
      close: async () => {
        closed = true;
      },
    },
  ]);

  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.connections, []);
  assert.equal(closed, true);
  assert.deepEqual(result.failures, [
    {
      serverName: "broken-tools",
      message: "Could not list tools: bad tool schema",
    },
  ]);
});

test("MCP tool output is bounded without losing both ends of the result", async () => {
  const largeOutput = `start:${"x".repeat(120_000)}:end`;
  const result = await listMcpTools([
    {
      serverName: "large-output",
      client: {
        listTools: async () => ({
          tools: [
            { name: "huge_result", description: "returns a large result" },
          ],
        }),
        callTool: async () => ({
          content: [{ type: "text", text: largeOutput }],
        }),
      } as never,
      close: async () => {},
    },
  ]);

  const toolResult = await result.tools[0]!.execute({} as never, {});
  assert.ok("output" in toolResult);
  if (!("output" in toolResult)) throw new Error("Expected MCP output.");
  assert.ok(toolResult.output.length <= 100_000);
  assert.match(toolResult.output, /^start:/);
  assert.match(toolResult.output, /:end$/);
  assert.match(toolResult.output, /MCP tool output truncated from 120010/);
  assert.match(toolResult.output, /Narrow the next tool request/);
});

test("MCP inputSchema surfaces as tool parameters with required intact", async () => {
  const result = await listMcpTools([
    {
      serverName: "webstorm",
      client: {
        listTools: async () => ({
          tools: [
            {
              name: "read_file",
              description: "Read a file from the project",
              inputSchema: {
                type: "object",
                properties: {
                  file_path: { type: "string", description: "Path to the file" },
                  max_lines: { type: "integer", default: 100 },
                },
                required: ["file_path"],
              },
            },
          ],
        }),
      } as never,
      close: async () => {},
    },
  ]);

  const tool = result.tools[0]!;
  assert.equal(tool.name, "mcp__webstorm__read_file");
  assert.ok(tool.parameters);
  assert.deepEqual(tool.parameters?.required, ["file_path"]);
  assert.equal(tool.parameters?.properties?.file_path.type, "string");
  assert.doesNotMatch(tool.description, /^mcp__/);
  assert.match(tool.description, /MCP server "webstorm"/);
});

test("an exotic MCP schema leaves the tool registered without parameters", async () => {
  const result = await listMcpTools([
    {
      serverName: "exotic",
      client: {
        listTools: async () => ({
          tools: [
            {
              name: "weird",
              description: "weird tool",
              inputSchema: { oneOf: [{ type: "string" }, { type: "object" }] },
            },
          ],
        }),
      } as never,
      close: async () => {},
    },
  ]);

  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0]?.parameters, undefined);
});

test("readOnlyHint makes an MCP tool non-mutating; absent annotations stay mutating", async () => {
  const result = await listMcpTools([
    {
      serverName: "hints",
      client: {
        listTools: async () => ({
          tools: [
            {
              name: "get_status",
              description: "read-only status",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
            {
              name: "apply_change",
              description: "mutating change",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }),
      } as never,
      close: async () => {},
    },
  ]);

  const readOnly = result.tools.find((t) => t.name.endsWith("get_status"))!;
  const mutating = result.tools.find((t) => t.name.endsWith("apply_change"))!;
  assert.equal(readOnly.mutating, false);
  assert.equal(readOnly.kind, "fetch");
  assert.equal(mutating.mutating, true);
  assert.equal(mutating.kind, "execute");
});

test("workspace-root shaped MCP string properties get a cwd hint", async () => {
  const result = await listMcpTools([
    {
      serverName: "webstorm",
      client: {
        listTools: async () => ({
          tools: [
            {
              name: "search_text",
              description: "search the project",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  projectPath: { type: "string", description: "Project to search" },
                  workspace_root: { type: "string" },
                },
                required: ["query"],
              },
            },
          ],
        }),
      } as never,
      close: async () => {},
    },
  ]);

  const parameters = result.tools[0]?.parameters;
  assert.ok(parameters);
  assert.match(
    String(parameters?.properties?.projectPath.description),
    /Project to search \(pass the workspace root given at the top of this prompt\)/,
  );
  assert.match(
    String(parameters?.properties?.workspace_root.description),
    /pass the workspace root/,
  );
  assert.equal(parameters?.properties?.query.description, undefined);
});
