import type * as acp from "@agentclientprotocol/sdk";
import type { BackgroundToolApi } from "../background.js";
import type { ToolHost } from "../../core/tool-host.js";
import type {
  ToolAvailabilityContext,
  ToolEnvironment,
} from "./environment.js";
import type { ToolParameters } from "./schema.js";

export type ToolContext = {
  host: ToolHost;
  sessionId: string;
  toolCallId: string;
  cwd: string;
  environment: ToolEnvironment;
  signal: AbortSignal;
  background?: BackgroundToolApi;
  requestPermission(
    toolCallId: string,
    tool: ToolDefinition,
    args: Record<string, unknown>,
  ): Promise<boolean>;
};

export type ToolDiff = {
  path: string;
  oldText: string | null;
  newText: string;
};

export type ToolResult =
  | {
      output: string;
      diff?: ToolDiff;
      /** Prevent another tool from running after a least-privilege mode change. */
      disableFurtherTools?: boolean;
    }
  | { error: string };

export type ToolDefinition = {
  name: string;
  description: string;
  /** Args schema; when absent, central pre-dispatch validation is skipped. */
  parameters?: ToolParameters;
  requiredCapability?: (caps: acp.ClientCapabilities | undefined) => boolean;
  isAvailable?: (ctx: ToolAvailabilityContext) => boolean;
  mutating: boolean;
  kind: acp.ToolKind;
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
};
