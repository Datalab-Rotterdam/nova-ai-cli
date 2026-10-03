import type { AgentEvent } from "./agent-events.js";
import type { BackgroundToolApi } from "./background.js";
import type { ToolHost } from "./tool-host.js";
import { truncateToolOutput } from "./tool-output.js";
import type { ToolEnvironment } from "./tools/environment.js";
import { formatArgIssues, validateToolArgs } from "./tools/schema.js";
import type { ToolDefinition } from "./tools/types.js";

export const MAX_TOOL_CALLS_PER_ROUND = 8;

export type BatchCall =
  | { kind: "call"; name: string; args: Record<string, unknown> }
  | { kind: "malformed" };

export type BatchEntry = {
  name: string;
  status: "ok" | "error" | "rejected" | "skipped";
  /** Model-facing result, e.g. "Tool result: ..." or "Tool error: ...". */
  body: string;
};

/** Outcome of the permission policy for one call. */
export type ToolAuthorization =
  | { allowed: true }
  | { allowed: false; reason: "rule" | "user" };

export type ToolBatchContext = {
  host: ToolHost;
  sessionId: string;
  cwd: string;
  environment: ToolEnvironment;
  background?: BackgroundToolApi;
  signal: AbortSignal;
  findTool(name: string): ToolDefinition | undefined;
  requestPermission(
    toolCallId: string,
    tool: ToolDefinition,
    args: Record<string, unknown>,
  ): Promise<boolean>;
  emit(event: AgentEvent): void | Promise<void>;
  /** Called when a tool asks to stop every later tool (least-privilege mode change). */
  disableTools(): void;
  /**
   * The agent's permission policy, consulted for every call (deny rules also
   * cover read-only tools). Without it, only mutating tools go through
   * requestPermission.
   */
  authorize?(
    toolCallId: string,
    tool: ToolDefinition,
    args: Record<string, unknown>,
  ): Promise<ToolAuthorization>;
};

/**
 * Runs one round of tool calls in order, with the same rules for every tool
 * protocol: at most MAX_TOOL_CALLS_PER_ROUND, schema validation before
 * dispatch, permission for mutating tools, and a user rejection skips the
 * rest of the batch so the model re-plans. Returns one entry per call, in
 * call order. Rethrows when the turn was cancelled, leaving the finished
 * calls in `entries`.
 */
export async function runToolBatch(
  calls: BatchCall[],
  ctx: ToolBatchContext,
  /** Filled as calls finish, so a caller still sees them if the batch throws. */
  entries: BatchEntry[] = [],
): Promise<BatchEntry[]> {
  let skipReason: string | null = null;

  for (let index = 0; index < calls.length; index++) {
    const block = calls[index]!;
    const blockName = block.kind === "call" ? block.name : "(unparseable)";

    if (index >= MAX_TOOL_CALLS_PER_ROUND) {
      entries.push({
        name: blockName,
        status: "rejected",
        body: `Rejected: too many tool calls in one turn (maximum ${MAX_TOOL_CALLS_PER_ROUND}). Re-issue this call in a later turn.`,
      });
      continue;
    }
    if (block.kind === "malformed") {
      entries.push({
        name: blockName,
        status: "error",
        body: "This tool_call block could not be parsed as JSON. Re-emit just this call as one valid block.",
      });
      continue;
    }
    if (skipReason) {
      entries.push({ name: block.name, status: "skipped", body: skipReason });
      continue;
    }

    // findTool also returns undefined after a least-privilege transition
    // disabled tools mid-turn; the legacy message covers both cases.
    const tool = ctx.findTool(block.name);
    if (!tool) {
      entries.push({
        name: block.name,
        status: "error",
        body: `Tool "${block.name}" is not available.`,
      });
      continue;
    }

    const toolCallId = crypto.randomUUID();
    let args = block.args;
    if (tool.parameters) {
      const validation = validateToolArgs(tool.parameters, args);
      if (!validation.ok) {
        const correction = formatArgIssues(
          tool.name,
          validation.issues,
          tool.parameters,
        );
        // Surface the rejected call so clients can show why nothing
        // executed; no permission prompt fires for a call that was never
        // dispatched.
        await ctx.emit({
          type: "tool_pending",
          toolCallId,
          name: tool.name,
          mutating: tool.mutating,
          kind: tool.kind,
          args,
        });
        await ctx.emit({
          type: "tool_update",
          toolCallId,
          status: "failed",
          output: correction,
        });
        entries.push({ name: block.name, status: "error", body: correction });
        continue;
      }
      args = validation.args;
    }

    await ctx.emit({
      type: "tool_pending",
      toolCallId,
      name: tool.name,
      mutating: tool.mutating,
      kind: tool.kind,
      args,
    });

    const toolCtx = {
      host: ctx.host,
      sessionId: ctx.sessionId,
      toolCallId,
      cwd: ctx.cwd,
      environment: ctx.environment,
      background: ctx.background,
      signal: ctx.signal,
      requestPermission: ctx.requestPermission,
    };
    try {
      const authorization: ToolAuthorization = ctx.authorize
        ? await ctx.authorize(toolCallId, tool, args)
        : !tool.mutating || (await ctx.requestPermission(toolCallId, tool, args))
          ? { allowed: true }
          : { allowed: false, reason: "user" };
      if (!authorization.allowed && authorization.reason === "rule") {
        await ctx.emit({
          type: "tool_update",
          toolCallId,
          status: "failed",
          output: "Blocked by a deny rule in the Nova settings.",
        });
        entries.push({
          name: block.name,
          status: "rejected",
          body: "Tool call blocked by a deny rule in the user's Nova settings. Do not retry it; take another approach or ask the user.",
        });
        continue;
      }
      if (!authorization.allowed) {
        await ctx.emit({
          type: "tool_update",
          toolCallId,
          status: "failed",
          output: "Permission denied by user.",
        });
        entries.push({
          name: block.name,
          status: "rejected",
          body: "Tool call rejected by user.",
        });
        // A rejection usually invalidates the model's plan for the rest of
        // the batch — force a re-plan instead of running the remainder.
        skipReason =
          "Skipped: an earlier call in this batch was rejected by the user. Re-plan before retrying.";
        continue;
      }

      const result = await tool.execute(toolCtx, args);
      // A privilege-reducing transition must take effect before any awaited
      // rendering/notification work below can fail.
      if (!("error" in result) && result.disableFurtherTools) {
        ctx.disableTools();
      }
      if ("error" in result) {
        await ctx.emit({
          type: "tool_update",
          toolCallId,
          status: "failed",
          output: result.error,
        });
        entries.push({
          name: block.name,
          status: "error",
          body: `Tool error: ${truncateToolOutput(result.error)}`,
        });
      } else {
        await ctx.emit({
          type: "tool_update",
          toolCallId,
          status: "completed",
          output: result.output,
          diff: result.diff,
        });
        entries.push({
          name: block.name,
          status: "ok",
          body: `Tool result: ${truncateToolOutput(result.output)}`,
        });
      }
    } catch (error) {
      const message = ctx.signal.aborted
        ? "Canceled."
        : errorMessage(error, `Tool ${tool.name} failed unexpectedly.`);
      await ctx.emit({
        type: "tool_update",
        toolCallId,
        status: "failed",
        output: message,
      });
      if (ctx.signal.aborted) throw error;
      entries.push({
        name: block.name,
        status: "error",
        body: `Tool error: ${truncateToolOutput(message)}`,
      });
    }
  }

  return entries;
}

/**
 * A single call keeps the legacy "Tool result:"/"Tool error:" message shape
 * (stored sessions and context accounting key off those prefixes); multiple
 * calls come back numbered in one combined message.
 */
export function formatBatchResults(entries: BatchEntry[]): string {
  if (entries.length === 1) return entries[0]!.body;
  const sections = entries.map(
    (entry, index) =>
      `[${index + 1}] ${entry.name} → ${entry.status}\n${entry.body}`,
  );
  return `Tool results (${entries.length} calls):\n${sections.join("\n")}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
