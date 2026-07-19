import type * as acp from "@agentclientprotocol/sdk";
import type { ToolDiff } from "../acp/tools/types.js";

export type AgentEvent =
  | { type: "text"; text: string }
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
