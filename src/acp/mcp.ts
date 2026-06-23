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
  return new StdioClientTransport({
    command: stdio.command,
    args: stdio.args,
    env: Object.fromEntries(stdio.env.map((e) => [e.name, e.value])),
  });
}

export type McpConnection = {
  serverName: string;
  client: Client;
  close(): Promise<void>;
};

export async function connectMcpServers(servers: acp.McpServer[]): Promise<McpConnection[]> {
  const connections: McpConnection[] = [];
  for (const server of servers) {
    if ("type" in server && server.type === "acp") continue; // experimental ACP-transport MCP, not yet supported

    const client = new Client({ name: "nova-ai-cli", version: "1.0.0" });
    const transport = buildTransport(server);
    try {
      await client.connect(transport);
      connections.push({ serverName: server.name, client, close: () => client.close() });
    } catch (err) {
      console.error(`Failed to connect MCP server "${server.name}": ${(err as Error).message}`);
    }
  }
  return connections;
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

export async function listMcpTools(connections: McpConnection[]): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];

  for (const connection of connections) {
    const { tools: serverTools } = await connection.client.listTools();
    for (const tool of serverTools) {
      const qualifiedName = `${TOOL_NAME_PREFIX}${sanitize(connection.serverName)}__${sanitize(tool.name)}`;
      tools.push({
        name: qualifiedName,
        description: `${qualifiedName}: ${tool.description ?? tool.name} (from MCP server "${connection.serverName}")`,
        requiredCapability: () => true,
        mutating: true,
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

  return tools;
}
