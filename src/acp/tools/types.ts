import type * as acp from "@agentclientprotocol/sdk";

export type ToolContext = {
  client: acp.AgentContext;
  sessionId: string;
  signal: AbortSignal;
};

export type ToolResult = { output: string } | { error: string };

export type ToolDefinition = {
  name: string;
  description: string;
  requiredCapability: (caps: acp.ClientCapabilities | undefined) => boolean;
  mutating: boolean;
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
};
