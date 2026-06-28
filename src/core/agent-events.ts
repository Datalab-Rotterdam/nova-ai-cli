export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_pending"; toolCallId: string; name: string; mutating: boolean; args: Record<string, unknown> }
  | { type: "tool_update"; toolCallId: string; status: "completed" | "failed"; output: string }
  | { type: "end_turn"; stopReason: "end_turn" | "max_turn_requests" | "cancelled" }
  | { type: "error"; message: string };
