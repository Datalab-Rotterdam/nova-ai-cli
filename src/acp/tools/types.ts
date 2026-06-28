import type * as acp from "@agentclientprotocol/sdk";
import type { BackgroundToolApi } from "../background.js";
import type { ToolHost } from "../../core/tool-host.js";
import type { ToolAvailabilityContext, ToolEnvironment } from "./environment.js";

export type ToolContext = {
  host: ToolHost;
  sessionId: string;
  cwd: string;
  environment: ToolEnvironment;
  signal: AbortSignal;
  background?: BackgroundToolApi;
  requestPermission(toolCallId: string, tool: ToolDefinition, args: Record<string, unknown>): Promise<boolean>;
};

export type ToolResult = { output: string } | { error: string };

export type ToolDefinition = {
  name: string;
  description: string;
  requiredCapability?: (caps: acp.ClientCapabilities | undefined) => boolean;
  isAvailable?: (ctx: ToolAvailabilityContext) => boolean;
  mutating: boolean;
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
};
