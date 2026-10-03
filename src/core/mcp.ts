import type * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { truncateToolOutput } from "./tool-output.js";
import { toToolParameters, type ToolParameters } from "./tools/schema.js";
import type { ToolDefinition, ToolResult } from "./tools/types.js";

const TOOL_NAME_PREFIX = "mcp__";

const WORKSPACE_PATH_PROPERTY =
  /^(project_?path|workspace_?(root|path)?|root|cwd|(base_?)?dir(ectory)?)$/i;
const WORKSPACE_PATH_HINT =
  "pass the workspace root given at the top of this prompt";

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * MCP servers often need the project/workspace root as an argument but
 * cannot know it themselves; models routinely omit it. Point workspace-root
 * shaped string properties at the cwd stated in the system prompt.
 */
function annotateWorkspacePathHints(parameters: ToolParameters): ToolParameters {
  if (!parameters.properties) return parameters;
  const properties: NonNullable<ToolParameters["properties"]> = {};
  for (const [name, schema] of Object.entries(parameters.properties)) {
    if (schema.type === "string" && WORKSPACE_PATH_PROPERTY.test(name)) {
      properties[name] = {
        ...schema,
        description: schema.description
          ? `${schema.description} (${WORKSPACE_PATH_HINT})`
          : WORKSPACE_PATH_HINT,
      };
    } else {
      properties[name] = schema;
    }
  }
  return { ...parameters, properties };
}

function headersToRecord(headers: acp.HttpHeader[]): Record<string, string> {
  return Object.fromEntries(headers.map((h) => [h.name, h.value]));
}

/** How long one MCP server may take to connect, and to list its tools. */
export const MCP_TIMEOUT_MS = 10_000;
const STDERR_TAIL_CHARS = 2_000;

function buildTransport(
  server: acp.McpServer,
  stderrTail: { text: string },
): Transport {
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
  // Always drained (a full pipe would block the server); the tail explains failures.
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrTail.text = (stderrTail.text + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
  });
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

/**
 * Connects all servers in parallel; each gets `timeoutMs`, so one slow or
 * hung server cannot hold up the session. Failures are reported, never thrown.
 */
export async function connectMcpServers(
  servers: acp.McpServer[],
  options: { timeoutMs?: number } = {},
): Promise<McpConnectionResult> {
  const timeoutMs = options.timeoutMs ?? MCP_TIMEOUT_MS;
  const attempts = await Promise.all(
    servers
      // experimental ACP-transport MCP, not yet supported
      .filter((server) => !("type" in server && server.type === "acp"))
      .map(async (server): Promise<McpConnection | McpConnectionFailure> => {
        const client = new Client({ name: "nova-ai-cli", version: "1.0.0" });
        const stderrTail = { text: "" };
        try {
          const transport = buildTransport(server, stderrTail);
          await withTimeout(client.connect(transport), timeoutMs, () => client.close());
          return { serverName: server.name, client, close: () => client.close() };
        } catch (err) {
          await client.close().catch(() => {});
          const reason = err instanceof Error ? err.message : "Connection failed.";
          const stderr = stderrTail.text.trim();
          return {
            serverName: server.name,
            message: stderr ? `${reason}\n${stderr}` : reason,
          };
        }
      }),
  );
  const connections = attempts.filter((a): a is McpConnection => "client" in a);
  const failures = attempts.filter((a): a is McpConnectionFailure => !("client" in a));
  return { connections, failures };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<unknown> | void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void Promise.resolve(onTimeout()).catch(() => {});
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function closeMcpConnections(
  connections: McpConnection[],
): Promise<void> {
  await Promise.all(connections.map((c) => c.close().catch(() => {})));
}

function toToolResult(result: {
  content?: unknown;
  isError?: boolean;
}): ToolResult {
  const rawText = Array.isArray(result.content)
    ? result.content
        .map((block: unknown) => {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as { type: string }).type === "text"
          ) {
            return (block as { type: string; text: string }).text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n")
    : "";
  const text = truncateToolOutput(rawText, "MCP tool");

  if (result.isError) return { error: text || "MCP tool call failed." };
  return { output: text };
}

export async function listMcpTools(
  connections: McpConnection[],
  options: { timeoutMs?: number } = {},
): Promise<{
  tools: ToolDefinition[];
  connections: McpConnection[];
  failures: McpConnectionFailure[];
}> {
  const tools: ToolDefinition[] = [];
  const readyConnections: McpConnection[] = [];
  const failures: McpConnectionFailure[] = [];

  const timeoutMs = options.timeoutMs ?? MCP_TIMEOUT_MS;
  const listed = await Promise.all(
    connections.map((connection) =>
      withTimeout(connection.client.listTools(), timeoutMs, () => connection.close()).then(
        (result) => ({ connection, result, error: null as unknown }),
        (error: unknown) => ({ connection, result: null, error }),
      ),
    ),
  );
  const usedNames = new Set<string>();

  for (const { connection, result, error } of listed) {
    let serverTools;
    if (result) {
      serverTools = result.tools;
      readyConnections.push(connection);
    } else {
      failures.push({
        serverName: connection.serverName,
        message:
          error instanceof Error
            ? `Could not list tools: ${error.message}`
            : "Could not list tools.",
      });
      await connection.close().catch(() => {});
      continue;
    }
    for (const tool of serverTools) {
      // Sanitizing can map different names to one; keep every tool reachable.
      const baseName = `${TOOL_NAME_PREFIX}${sanitize(connection.serverName)}__${sanitize(tool.name)}`;
      let qualifiedName = baseName;
      for (let suffix = 2; usedNames.has(qualifiedName); suffix++) {
        qualifiedName = `${baseName}_${suffix}`;
      }
      usedNames.add(qualifiedName);
      const parameters = toToolParameters(tool.inputSchema);
      // Only an explicit readOnlyHint skips the permission prompt; absent
      // annotations stay mutating (conservative default).
      const readOnly = tool.annotations?.readOnlyHint === true;
      tools.push({
        name: qualifiedName,
        description: `${tool.description ?? tool.name} (MCP server "${connection.serverName}")`,
        parameters: parameters && annotateWorkspacePathHints(parameters),
        mutating: !readOnly,
        kind: readOnly ? "fetch" : "execute",
        async execute(ctx, args) {
          try {
            const result = await connection.client.callTool(
              { name: tool.name, arguments: args },
              undefined,
              { signal: ctx.signal },
            );
            return toToolResult(
              result as { content?: unknown; isError?: boolean },
            );
          } catch (err) {
            return { error: (err as Error).message };
          }
        },
      });
    }
  }

  return { tools, connections: readyConnections, failures };
}
