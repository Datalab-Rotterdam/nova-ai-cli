import type { NovaAI, ChatMessage } from "@datalabrotterdam/nova-sdk";
import {
  extractToolCall,
  hasIncompleteToolCall,
  hasMalformedToolCall,
  hasPendingFence,
} from "../acp/tools/marker.js";
import type { BackgroundToolApi } from "../acp/background.js";
import type { ToolEnvironment } from "../acp/tools/environment.js";
import { formatArgIssues, validateToolArgs } from "../acp/tools/schema.js";
import type { ToolDefinition } from "../acp/tools/types.js";
import type { AgentEvent } from "./agent-events.js";
import {
  isContextLimitError,
  type ContextCompactionResult,
} from "./context-compaction.js";
import { ReasoningTagFilter, stripReasoningTags } from "./reasoning-tags.js";
import type { ToolHost } from "./tool-host.js";
import { truncateToolOutput } from "./tool-output.js";

const DEFAULT_MAX_TOOL_ROUNDS = 64;
const MAX_EMPTY_COMPLETION_RETRIES = 2;
const MAX_TRUNCATED_COMPLETION_RETRIES = 2;
const EMPTY_COMPLETION_INSTRUCTION =
  "The previous completion contained no visible assistant response. Continue the task now with either the next required tool call or a final answer.";
const TRUNCATED_COMPLETION_INSTRUCTION =
  "Your previous response was cut off. Continue exactly where it stopped. Do not restart, repeat the preamble, or claim completion without providing the actual result.";
const INCOMPLETE_TOOL_CALL_INSTRUCTION =
  "Your tool_call block was cut off. Re-emit the entire tool call from the opening marker as one complete, valid block. Do not include any of its JSON or file content as ordinary assistant text.";
const FINAL_RESPONSE_INSTRUCTION =
  "The tool-use safety limit has been reached. Do not call any more tools. Return a final answer now using the results already gathered, and clearly mention anything that remains unverified.";

export type RunTurnDeps = {
  host: ToolHost;
  sessionId: string;
  cwd: string;
  environment: ToolEnvironment;
  background?: BackgroundToolApi;
  tools: ToolDefinition[];
  requestPermission(
    toolCallId: string,
    tool: ToolDefinition,
    args: Record<string, unknown>,
  ): Promise<boolean>;
  compactContext?(
    messages: ChatMessage[],
    error: unknown,
  ): Promise<ContextCompactionResult>;
  /**
   * Drains user guidance that arrived while a tool round was running. The
   * callback is only read between model requests, never during a stream or
   * tool execution, so callers can steer an active turn without cancelling it.
   */
  takeSteeringMessages?(): ChatMessage[] | Promise<ChatMessage[]>;
  emit(event: AgentEvent): void | Promise<void>;
  novaClient: NovaAI;
  model: string;
  /** Primarily injectable for focused tests; production uses the safety cap. */
  maxToolRounds?: number;
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
export async function runTurn(
  messages: ChatMessage[],
  signal: AbortSignal,
  deps: RunTurnDeps,
): Promise<RunTurnResult> {
  const {
    host,
    sessionId,
    cwd,
    environment,
    background,
    tools,
    requestPermission,
    compactContext,
    takeSteeringMessages,
    emit,
    novaClient,
    model,
  } = deps;
  const maxToolRounds = Math.max(
    1,
    deps.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
  );
  let toolsEnabled = true;
  const findTool = (name: string) =>
    toolsEnabled ? tools.find((tool) => tool.name === name) : undefined;
  const turnMessages: ChatMessage[] = [];
  let contextCompactionUsed = false;
  let toolRounds = 0;
  let emptyCompletionRetries = 0;
  let truncatedCompletionRetries = 0;
  let continuationPrefix = "";
  let incompleteToolCallBuffer = "";
  let forceFinalResponse = false;
  let hasCompletedRound = false;

  const pushTurn = (message: ChatMessage) => {
    messages.push(message);
    turnMessages.push(message);
  };

  while (true) {
    if (signal.aborted) {
      return { stopReason: "cancelled", turnMessages };
    }

    if (hasCompletedRound && takeSteeringMessages) {
      const steeringMessages = await takeSteeringMessages();
      for (const message of steeringMessages) pushTurn(message);
    }
    hasCompletedRound = false;

    let buffer = "";
    let flushed = 0;
    let toolCall = null as ReturnType<typeof extractToolCall>;
    let finishReason: string | null = null;
    let streamDone = false;
    const reasoningFilter = new ReasoningTagFilter();
    let deferredVisibleText = "";
    const emitVisibleText = async (text: string) => {
      const visible = reasoningFilter.push(text);
      if (!visible) return;
      if (forceFinalResponse) deferredVisibleText += visible;
      else await emit({ type: "text", text: visible });
    };
    const finishVisibleText = async () => {
      const visible = reasoningFilter.finish();
      if (visible) {
        if (forceFinalResponse) deferredVisibleText += visible;
        else await emit({ type: "text", text: visible });
      }
    };

    while (true) {
      buffer = "";
      flushed = 0;
      toolCall = null;
      finishReason = null;
      streamDone = false;
      try {
        const retryInstruction = incompleteToolCallBuffer
          ? INCOMPLETE_TOOL_CALL_INSTRUCTION
          : continuationPrefix
            ? forceFinalResponse
              ? `${TRUNCATED_COMPLETION_INSTRUCTION} ${FINAL_RESPONSE_INSTRUCTION}`
              : TRUNCATED_COMPLETION_INSTRUCTION
            : forceFinalResponse
              ? FINAL_RESPONSE_INSTRUCTION
              : emptyCompletionRetries > 0
                ? EMPTY_COMPLETION_INSTRUCTION
                : null;
        const requestMessages = incompleteToolCallBuffer
          ? [
              ...messages,
              {
                role: "assistant" as const,
                content: continuationPrefix + incompleteToolCallBuffer,
              },
              { role: "user" as const, content: retryInstruction! },
            ]
          : continuationPrefix
            ? [
                ...messages,
                { role: "assistant" as const, content: continuationPrefix },
                { role: "user" as const, content: retryInstruction! },
              ]
            : retryInstruction
              ? [
                  ...messages,
                  { role: "user" as const, content: retryInstruction },
                ]
              : messages;
        for await (const event of novaClient.chat.completions.stream(
          { model, messages: requestMessages },
          { signal },
        )) {
          if (event.type === "done") {
            streamDone = true;
            continue;
          }
          if (event.type !== "chunk") continue;

          const choice = event.data.choices?.[0];
          if (typeof choice?.finish_reason === "string") {
            finishReason = choice.finish_reason;
          }
          const text = choice?.delta?.content;
          if (typeof text !== "string" || text.length === 0) continue;

          buffer += text;

          if (!hasPendingFence(buffer)) {
            const toFlush = buffer.slice(flushed);
            if (toFlush) {
              await emitVisibleText(toFlush);
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
            const beforeTool = buffer.slice(flushed, toolCall.matchStart);
            if (beforeTool) await emitVisibleText(beforeTool);
            buffer = buffer.slice(0, toolCall.matchEnd);
            break;
          }
        }
      } catch (error) {
        if (
          !contextCompactionUsed &&
          buffer.length === 0 &&
          compactContext &&
          isContextLimitError(error)
        ) {
          const result = await compactContext(messages, error);
          if (result.compacted) {
            contextCompactionUsed = true;
            await emit({
              type: "context_compacted",
              removedMessages: result.removedMessages,
              keptMessages: result.keptMessages,
            });
            continue;
          }
        }
        throw error;
      }
      break;
    }

    if (!toolCall) {
      if (!forceFinalResponse && hasMalformedToolCall(buffer)) {
        await finishVisibleText();
        pushTurn({
          role: "assistant",
          content: continuationPrefix + stripReasoningTags(buffer),
        });
        continuationPrefix = "";
        incompleteToolCallBuffer = "";
        pushTurn({
          role: "user",
          content:
            "Your tool_call block could not be parsed as JSON (e.g. unbalanced braces). " +
            'Re-emit exactly one valid tool call: ```tool_call\n{"name": "<tool name>", "args": { ... }}\n```',
        });
        emptyCompletionRetries = 0;
        truncatedCompletionRetries = 0;
        toolRounds++;
        if (toolRounds >= maxToolRounds) forceFinalResponse = true;
        hasCompletedRound = true;
        continue;
      }

      if (hasIncompleteToolCall(buffer)) {
        await finishVisibleText();
        if (truncatedCompletionRetries < MAX_TRUNCATED_COMPLETION_RETRIES) {
          incompleteToolCallBuffer = buffer;
          truncatedCompletionRetries++;
          emptyCompletionRetries = 0;
          deferredVisibleText = "";
          continue;
        }
        throw new Error(
          `The model tool call remained incomplete after ${MAX_TRUNCATED_COMPLETION_RETRIES + 1} attempts.`,
        );
      }
      incompleteToolCallBuffer = "";

      const remaining = buffer.slice(flushed);
      if (remaining) await emitVisibleText(remaining);
      await finishVisibleText();
      const cleanedBuffer = stripReasoningTags(buffer);
      if (!cleanedBuffer.trim()) {
        deferredVisibleText = "";
        if (emptyCompletionRetries < MAX_EMPTY_COMPLETION_RETRIES) {
          emptyCompletionRetries++;
          continue;
        }
        throw new Error(
          forceFinalResponse
            ? "The model did not provide a final response after reaching the tool-use safety limit."
            : `The model returned no visible assistant content after ${MAX_EMPTY_COMPLETION_RETRIES + 1} attempts.`,
        );
      }

      const completedAssistant = continuationPrefix + cleanedBuffer;
      const truncation = completionTruncationReason(
        cleanedBuffer,
        finishReason,
        streamDone,
      );
      if (truncation) {
        if (truncatedCompletionRetries < MAX_TRUNCATED_COMPLETION_RETRIES) {
          continuationPrefix = completedAssistant;
          truncatedCompletionRetries++;
          emptyCompletionRetries = 0;
          deferredVisibleText = "";
          continue;
        }
        throw new Error(
          `The model response remained incomplete after ${MAX_TRUNCATED_COMPLETION_RETRIES + 1} attempts (${truncation}).`,
        );
      }
      if (forceFinalResponse) {
        await emit({ type: "text", text: completedAssistant });
      }
      pushTurn({ role: "assistant", content: completedAssistant });
      return {
        stopReason: forceFinalResponse ? "max_turn_requests" : "end_turn",
        turnMessages,
      };
    }

    await finishVisibleText();
    if (forceFinalResponse) {
      deferredVisibleText = "";
      if (emptyCompletionRetries < MAX_EMPTY_COMPLETION_RETRIES) {
        emptyCompletionRetries++;
        hasCompletedRound = true;
        continue;
      }
      throw new Error(
        "The model kept requesting tools after reaching the tool-use safety limit and did not provide a final response.",
      );
    }

    const tool = findTool(toolCall.name);
    const toolCallId = crypto.randomUUID();

    pushTurn({
      role: "assistant",
      content:
        continuationPrefix +
        stripReasoningTags(buffer.slice(0, toolCall.matchStart)) +
        buffer.slice(toolCall.matchStart, toolCall.matchEnd),
    });
    continuationPrefix = "";
    incompleteToolCallBuffer = "";
    emptyCompletionRetries = 0;
    truncatedCompletionRetries = 0;
    toolRounds++;
    if (toolRounds >= maxToolRounds) forceFinalResponse = true;

    if (!tool) {
      pushTurn({
        role: "user",
        content: `Tool "${toolCall.name}" is not available.`,
      });
      hasCompletedRound = true;
      continue;
    }

    if (tool.parameters) {
      const validation = validateToolArgs(tool.parameters, toolCall.args);
      if (!validation.ok) {
        const correction = formatArgIssues(
          tool.name,
          validation.issues,
          tool.parameters,
        );
        // Surface the rejected call so clients can show why nothing executed;
        // no permission prompt fires for a call that was never dispatched.
        await emit({
          type: "tool_pending",
          toolCallId,
          name: tool.name,
          mutating: tool.mutating,
          kind: tool.kind,
          args: toolCall.args,
        });
        await emit({
          type: "tool_update",
          toolCallId,
          status: "failed",
          output: correction,
        });
        pushTurn({ role: "user", content: correction });
        hasCompletedRound = true;
        continue;
      }
      toolCall.args = validation.args;
    }

    await emit({
      type: "tool_pending",
      toolCallId,
      name: tool.name,
      mutating: tool.mutating,
      kind: tool.kind,
      args: toolCall.args,
    });

    const toolCtx = {
      host,
      sessionId,
      toolCallId,
      cwd,
      environment,
      background,
      signal,
      requestPermission,
    };
    try {
      const allowed =
        !tool.mutating ||
        (await requestPermission(toolCallId, tool, toolCall.args));
      if (!allowed) {
        await emit({
          type: "tool_update",
          toolCallId,
          status: "failed",
          output: "Permission denied by user.",
        });
        pushTurn({ role: "user", content: "Tool call rejected by user." });
        hasCompletedRound = true;
        continue;
      }

      const result = await tool.execute(toolCtx, toolCall.args);
      // A privilege-reducing transition must take effect before any awaited
      // rendering/notification work below can fail.
      if (!("error" in result) && result.disableFurtherTools) {
        toolsEnabled = false;
      }
      if ("error" in result) {
        await emit({
          type: "tool_update",
          toolCallId,
          status: "failed",
          output: result.error,
        });
        pushTurn({
          role: "user",
          content: `Tool error: ${truncateToolOutput(result.error)}`,
        });
      } else {
        await emit({
          type: "tool_update",
          toolCallId,
          status: "completed",
          output: result.output,
          diff: result.diff,
        });
        pushTurn({
          role: "user",
          content: `Tool result: ${truncateToolOutput(result.output)}`,
        });
      }
    } catch (error) {
      const message = signal.aborted
        ? "Canceled."
        : errorMessage(error, `Tool ${tool.name} failed unexpectedly.`);
      await emit({
        type: "tool_update",
        toolCallId,
        status: "failed",
        output: message,
      });
      if (signal.aborted) throw error;
      pushTurn({
        role: "user",
        content: `Tool error: ${truncateToolOutput(message)}`,
      });
    }
    hasCompletedRound = true;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function completionTruncationReason(
  text: string,
  finishReason: string | null,
  streamDone: boolean,
): string | null {
  const normalizedReason = finishReason?.toLowerCase();
  if (
    normalizedReason &&
    ["length", "max_tokens", "max_output_tokens"].includes(normalizedReason)
  ) {
    return `finish reason ${finishReason}`;
  }
  if (looksObviouslyIncomplete(text)) {
    return streamDone || finishReason
      ? "response ended mid-sentence"
      : "response ended mid-sentence without a terminal stream event";
  }
  return null;
}

function looksObviouslyIncomplete(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if ((trimmed.match(/```/g)?.length ?? 0) % 2 !== 0) return true;
  if (/[:,\[(\-]$/.test(trimmed)) return true;
  return /\b(?:(?:i|we)(?:'ve| have) completed|and|or|but|because|including|the|an?|to|of|for|with|from|by)$/i.test(
    trimmed,
  );
}
