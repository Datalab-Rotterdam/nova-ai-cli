import { createRequire } from "node:module";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { DemoInMemoryAuthProvider } from "@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js";

// express comes with the MCP SDK but without types here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const express = createRequire(import.meta.url)("express") as any;

/**
 * An MCP server behind OAuth for tests: discovery, dynamic client
 * registration, an authorize endpoint that approves at once (redirecting to
 * the client's redirect_uri with a code) and token exchange, all from the
 * SDK's demo provider. One tool, `echo`, at `<url>`.
 */
export async function startOAuthMcpServer(): Promise<{ url: string; close(): Promise<void> }> {
  const app = express();
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const mcpUrl = new URL("/mcp", base);
  const provider = new DemoInMemoryAuthProvider();
  app.use(mcpAuthRouter({ provider, issuerUrl: base, resourceServerUrl: mcpUrl }));
  app.post(
    "/mcp",
    requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) }),
    express.json(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (req: any, res: any) => {
      const mcp = new McpServer({ name: "oauth-test", version: "1.0.0" });
      mcp.registerTool("echo", { description: "echo" }, async () => ({ content: [{ type: "text", text: "echoed" }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => void transport.close());
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );
  return {
    url: mcpUrl.toString(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
