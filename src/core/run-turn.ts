import type { NovaAI, ChatMessage } from "@datalabrotterdam/nova-sdk";
import { extractToolCall, hasMalformedToolCall, hasPendingFence } from "../acp/tools/marker.js";
import type { BackgroundToolApi } from "../acp/background.js";
import type { ToolEnvironment } from "../acp/tools/environment.js";
import type { ToolDefinition } from "../acp/tools/types.js";
import type { AgentEvent } from "./agent-events.js";
import type { ToolHost } from "./tool-host.js";

const MAX_TOOL_ROUNDS = 10;

export type RunTurnDeps = {
  host: ToolHost;
  sessionId: string;
  cwd: string;
  environment: ToolEnvironment;
  background?: BackgroundToolApi;
  tools: ToolDefinition[];
  requestPermission(toolCallId: string, tool: ToolDefinition, args: Record<string, unknown>): Promise<boolean>;
  emit(event: AgentEvent): void | Promise<void>;
  novaClient: NovaAI;
  model: string;
};

export type RunTurnResult = {
  stopReason: "end_turn" | "max_turn_requests" | "cancelled";
  turnMessages: ChatMessage[];
};

/**
 * Transport-agnostic streaming + tool-call loop. `messages` is the full
 * request context (system prompt + history + the new user message); it is
 * mutated in place as rounds progress so subsequent rounds see prior tool
 * results, mirroring the original inline loop in NovaAgent.prompt().
 * `turnMessages` in the result holds only what this call generated (the
 * caller already owns the user message and appends these on top of it).
 */
export async function runTurn(messages: ChatMessage[], signal: AbortSignal, deps: RunTurnDeps): Promise<RunTurnResult> {
  const { host, sessionId, cwd, environment, background, tools, requestPermission, emit, novaClient, model } = deps;
  const findTool = (name: string) => tools.find((tool) => tool.name === name);
  const turnMessages: ChatMessage[] = [];

  const pushTurn = (message: ChatMessage) => {
    messages.push(message);
    turnMessages.push(message);
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) {
      return { stopReason: "cancelled", turnMessages };
    }

    let buffer = "";
    let flushed = 0;
    let toolCall = null as ReturnType<typeof extractToolCall>;

    for await (const event of novaClient.chat.completions.stream({ model, messages }, { signal })) {
      if (event.type !== "chunk") continue;

      const text = event.data.choices?.[0]?.delta?.content;
      if (typeof text !== "string" || text.length === 0) continue;

      buffer += text;

      if (!hasPendingFence(buffer)) {
        const toFlush = buffer.slice(flushed);
        if (toFlush) {
          await emit({ type: "text", text: toFlush });
          flushed = buffer.length;
        }
        continue;
      }

      // Stop consuming the stream as soon as one complete tool call fence has
      // arrived. Models sometimes ignore the "one tool call per turn" rule
      // and keep emitting more fenced blocks after the first — cutting the
      // turn here discards that hallucinated trailing content instead of
      // dumping it into history as unexecuted, user-visible markup.
      toolCall = extractToolCall(buffer);
      if (toolCall) {
        buffer = buffer.slice(0, toolCall.matchEnd);
        break;
      }
    }

    if (!toolCall) {
      if (hasMalformedToolCall(buffer)) {
        pushTurn({ role: "assistant", content: buffer });
        pushTurn({
          role: "user",
          content:
            "Your tool_call block could not be parsed as JSON (e.g. unbalanced braces). " +
            'Re-emit exactly one valid tool call: ```tool_call\n{"name": "<tool name>", "args": { ... }}\n```',
        });
        continue;
      }

      const remaining = buffer.slice(flushed);
      if (remaining) {
        await emit({ type: "text", text: remaining });
      }
      pushTurn({ role: "assistant", content: buffer });
      return { stopReason: "end_turn", turnMessages };
    }

    const tool = findTool(toolCall.name);
    const toolCallId = crypto.randomUUID();

    pushTurn({ role: "assistant", content: buffer });

    if (!tool) {
      pushTurn({ role: "user", content: `Tool "${toolCall.name}" is not available.` });
      continue;
    }

    await emit({
      type: "tool_pending",
      toolCallId,
      name: tool.name,
      mutating: tool.mutating,
      args: toolCall.args,
    });

    const toolCtx = { host, sessionId, cwd, environment, background, signal, requestPermission };
    const allowed = !tool.mutating || (await requestPermission(toolCallId, tool, toolCall.args));
    if (!allowed) {
      await emit({ type: "tool_update", toolCallId, status: "failed", output: "Permission denied by user." });
      pushTurn({ role: "user", content: "Tool call rejected by user." });
      continue;
    }

    const result = await tool.execute(toolCtx, toolCall.args);
    if ("error" in result) {
      await emit({ type: "tool_update", toolCallId, status: "failed", output: result.error });
      pushTurn({ role: "user", content: `Tool error: ${result.error}` });
    } else {
      await emit({ type: "tool_update", toolCallId, status: "completed", output: result.output });
      pushTurn({ role: "user", content: `Tool result: ${result.output}` });
    }
  }

  return { stopReason: "max_turn_requests", turnMessages };
}
