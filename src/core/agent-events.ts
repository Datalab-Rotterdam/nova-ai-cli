import type * as acp from "@agentclientprotocol/sdk";
import type { ToolDiff } from "./tools/types.js";

export type AgentEvent =
  | { type: "text"; text: string }
  /** Model reasoning (reasoning_content or <think> blocks), never part of the answer. */
  | { type: "thought"; text: string }
  /** Token counts the server reported for one request. */
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "context_compacted"; removedMessages: number; keptMessages: number }
  | { type: "context_compaction_failed"; reason: string }
  | {
      type: "tool_pending";
      toolCallId: string;
      name: string;
      mutating: boolean;
      kind: acp.ToolKind;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_update";
      toolCallId: string;
      status: "completed" | "failed";
      output: string;
      diff?: ToolDiff;
    }
  | {
      type: "end_turn";
      stopReason: "end_turn" | "max_turn_requests" | "cancelled";
    }
  | { type: "error"; message: string };
