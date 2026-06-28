import type { ToolContext, ToolDefinition } from "./types.js";

export async function requestPermissionIfNeeded(
  ctx: ToolContext,
  toolCallId: string,
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<boolean> {
  if (!tool.mutating) return true;
  return ctx.requestPermission(toolCallId, tool, args);
}
