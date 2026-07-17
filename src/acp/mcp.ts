import type * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDefinition, ToolResult } from "./tools/types.js";

const TOOL_NAME_PREFIX = "mcp__";

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function headersToRecord(headers: acp.HttpHeader[]): Record<string, string> {
  return Object.fromEntries(headers.map((h) => [h.name, h.value]));
}

function buildTransport(server: acp.McpServer): Transport {
  if ("type" in server && server.type === "http") {
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: headersToRecord(server.headers) },
    });
  }
  if ("type" in server && server.type === "sse") {
    return new SSEClientTransport(new URL(server.url), {
      requestInit: { headers: headersToRecord(server.headers) },
    });
  }
  const stdio = server as acp.McpServerStdio;
  const transport = new StdioClientTransport({
    command: stdio.command,
    args: stdio.args,
    env: Object.fromEntries(stdio.env.map((e) => [e.name, e.value])),
    // MCP processes are part of the interactive agent runtime. Inheriting
    // stderr would write through the TUI's synchronized renderer and leave
    // corrupt rows behind. Connection failures are returned through ACP
    // status metadata instead.
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  return transport;
}

export type McpConnection = {
  serverName: string;
  client: Client;
  close(): Promise<void>;
};

export type McpConnectionFailure = {
  serverName: string;
  message: string;
};

export type McpConnectionResult = {
  connections: McpConnection[];
  failures: McpConnectionFailure[];
};

export async function connectMcpServers(servers: acp.McpServer[]): Promise<McpConnectionResult> {
  const connections: McpConnection[] = [];
  const failures: McpConnectionFailure[] = [];
  for (const server of servers) {
    if ("type" in server && server.type === "acp") continue; // experimental ACP-transport MCP, not yet supported

    const client = new Client({ name: "nova-ai-cli", version: "1.0.0" });
    try {
      const transport = buildTransport(server);
      await client.connect(transport);
      connections.push({ serverName: server.name, client, close: () => client.close() });
    } catch (err) {
      failures.push({
        serverName: server.name,
        message: err instanceof Error ? err.message : "Connection failed.",
      });
    }
  }
  return { connections, failures };
}

export async function closeMcpConnections(connections: McpConnection[]): Promise<void> {
  await Promise.all(connections.map((c) => c.close().catch(() => {})));
}

function toToolResult(result: { content?: unknown; isError?: boolean }): ToolResult {
  const text = Array.isArray(result.content)
    ? result.content
        .map((block: unknown) => {
          if (typeof block === "object" && block !== null && "type" in block && (block as { type: string }).type === "text") {
            return (block as { type: string; text: string }).text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n")
    : "";

  if (result.isError) return { error: text || "MCP tool call failed." };
  return { output: text };
}

export async function listMcpTools(connections: McpConnection[]): Promise<{
  tools: ToolDefinition[];
  connections: McpConnection[];
  failures: McpConnectionFailure[];
}> {
  const tools: ToolDefinition[] = [];
  const readyConnections: McpConnection[] = [];
  const failures: McpConnectionFailure[] = [];

  for (const connection of connections) {
    let serverTools;
    try {
      ({ tools: serverTools } = await connection.client.listTools());
      readyConnections.push(connection);
    } catch (error) {
      failures.push({
        serverName: connection.serverName,
        message: error instanceof Error ? `Could not list tools: ${error.message}` : "Could not list tools.",
      });
      await connection.close().catch(() => {});
      continue;
    }
    for (const tool of serverTools) {
      const qualifiedName = `${TOOL_NAME_PREFIX}${sanitize(connection.serverName)}__${sanitize(tool.name)}`;
      tools.push({
        name: qualifiedName,
        description: `${qualifiedName}: ${tool.description ?? tool.name} (from MCP server "${connection.serverName}")`,
        requiredCapability: () => true,
        mutating: true,
        kind: "execute",
        async execute(_ctx, args) {
          try {
            const result = await connection.client.callTool({ name: tool.name, arguments: args });
            return toToolResult(result as { content?: unknown; isError?: boolean });
          } catch (err) {
            return { error: (err as Error).message };
          }
        },
      });
    }
  }

  return { tools, connections: readyConnections, failures };
}
