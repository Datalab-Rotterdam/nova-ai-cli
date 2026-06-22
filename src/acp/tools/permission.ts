import * as acp from "@agentclientprotocol/sdk";
import type { ToolContext, ToolDefinition } from "./types.js";

export async function requestPermissionIfNeeded(
  ctx: ToolContext,
  toolCallId: string,
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<boolean> {
  if (!tool.mutating) return true;

  const response = await ctx.client.request(
    acp.methods.client.session.requestPermission,
    {
      sessionId: ctx.sessionId,
      toolCall: {
        toolCallId,
        title: tool.name,
        kind: "execute",
        status: "pending",
        rawInput: args,
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
    { cancellationSignal: ctx.signal },
  );

  return response.outcome.outcome === "selected" && response.outcome.optionId === "allow";
}
