import * as acp from "@agentclientprotocol/sdk";
import type { ToolContext, ToolDefinition } from "./types.js";

export async function sendToolCallPending(
  ctx: ToolContext,
  toolCallId: string,
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<void> {
  await ctx.client.notify(acp.methods.client.session.update, {
    sessionId: ctx.sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title: tool.name,
      kind: tool.mutating ? "execute" : "read",
      status: "pending",
      rawInput: args,
    },
  });
}

export async function sendToolCallUpdate(
  ctx: ToolContext,
  toolCallId: string,
  status: "completed" | "failed",
  output: string,
): Promise<void> {
  await ctx.client.notify(acp.methods.client.session.update, {
    sessionId: ctx.sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status,
      content: [{ type: "content", content: { type: "text", text: output } }],
      rawOutput: { output },
    },
  });
}
