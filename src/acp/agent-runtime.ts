import type * as acp from "@agentclientprotocol/sdk";
import type { Session } from "../core/agent/session.js";
import type { ModelService } from "./model-service.js";

/** What the ACP services need from the agent that owns them. */
export interface AgentRuntime {
  readonly clientCapabilities: acp.ClientCapabilities | undefined;
  readonly positionEncoding: acp.PositionEncodingKind;
  readonly models: ModelService;
  requireSession(sessionId: string): Session;
}
