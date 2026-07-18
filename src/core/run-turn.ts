import type { NovaAI, ChatMessage } from "@datalabrotterdam/nova-sdk";
import {
  hasIncompleteToolCall,
  hasMalformedToolCall,
  hasPendingFence,
  scanToolCalls,
  stripToolCallMarkup,
  tailMayContinueToolCalls,
  type ToolCallScan,
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
import { estimateMessagesTokens } from "./context-usage.js";
import { ReasoningTagFilter, stripReasoningTags } from "./reasoning-tags.js";
import type { ToolHost } from "./tool-host.js";
import { truncateToolOutput } from "./tool-output.js";

const DEFAULT_MAX_TOOL_ROUNDS = 64;
const MAX_EMPTY_COMPLETION_RETRIES = 2;
const MAX_TRUNCATED_COMPLETION_RETRIES = 2;
const PROACTIVE_COMPACTION_THRESHOLD = 0.8;
const MAX_TOOL_CALLS_PER_ROUND = 8;
const EMPTY_COMPLETION_INSTRUCTION =
  "The previous completion contained no visible assistant response. Continue the task now with either the next required tool call or a final answer.";
const TRUNCATED_COMPLETION_INSTRUCTION =
  "Your previous response was cut off. Continue exactly where it stopped. Do not restart, repeat the preamble, or claim completion without providing the actual result.";
const INCOMPLETE_TOOL_CALL_INSTRUCTION =
  "Your tool_call block was cut off. Continue exactly at the next character and finish the JSON plus its closing marker. Emit only the missing suffix: do not restart the tool call, repeat its existing JSON, or turn any file content into ordinary assistant text.";
const ABANDON_INCOMPLETE_TOOL_CALL_INSTRUCTION =
  "The attempted tool call was too large to finish after multiple streamed continuations and was not executed. Do not retry the same large call. Split the work into smaller tool calls, or return a final answer using the results already gathered.";
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
    /** null when compaction is proactive rather than error-driven. */
    error: unknown,
  ): Promise<ContextCompactionResult>;
  /** Enables proactive compaction before the estimate exceeds the window. */
  contextWindow?: number | null;
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
  let proactiveCompactionUsed = false;
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

    // Compact before the request when the estimate nears the window instead
    // of waiting for the API to reject it. The reactive error path below
    // stays independent as a backstop for a bad estimate.
    if (
      !proactiveCompactionUsed &&
      compactContext &&
      typeof deps.contextWindow === "number" &&
      deps.contextWindow > 0 &&
      estimateMessagesTokens(messages) >
        deps.contextWindow * PROACTIVE_COMPACTION_THRESHOLD
    ) {
      proactiveCompactionUsed = true;
      const result = await compactContext(messages, null);
      if (result.compacted) {
        await emit({
          type: "context_compacted",
          removedMessages: result.removedMessages,
          keptMessages: result.keptMessages,
        });
      }
    }

    let buffer = "";
    let flushed = 0;
    let scanned: ToolCallScan | null = null;
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
      const toolCallContinuation = incompleteToolCallBuffer;
      let responseBuffer = "";
      let restartedToolCall = false;
      buffer = toolCallContinuation;
      flushed = buffer.length;
      scanned = null;
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

          responseBuffer += text;
          // Prefer a fresh call when the model ignored the suffix-only
          // instruction and restarted at an opening marker. Otherwise append
          // the response to the partial call so payloads larger than one model
          // completion can make progress instead of repeating the same cutoff.
          if (
            toolCallContinuation &&
            !restartedToolCall &&
            /^\s*(?:```tool_call|<\|tool_call>)/.test(responseBuffer)
          ) {
            restartedToolCall = true;
            flushed = 0;
          }
          buffer = restartedToolCall
            ? responseBuffer
            : toolCallContinuation + responseBuffer;

          if (!hasPendingFence(buffer)) {
            const toFlush = buffer.slice(flushed);
            if (toFlush) {
              await emitVisibleText(toFlush);
              flushed = buffer.length;
            }
            continue;
          }

          // Once at least one complete block has arrived, keep consuming only
          // while the tail could still grow into another back-to-back block
          // (whitespace or a marker prefix). Anything else after the blocks is
          // fabricated "results" prose — cut the stream and discard it rather
          // than dumping it into history as unexecuted, user-visible markup.
          const scan = scanToolCalls(buffer);
          if (scan.blocks.length > 0) {
            const tail = buffer.slice(scan.lastMatchEnd);
            if (!tailMayContinueToolCalls(tail)) {
              const beforeTool = buffer.slice(
                flushed,
                scan.blocks[0]!.matchStart,
              );
              if (beforeTool) await emitVisibleText(beforeTool);
              buffer = buffer.slice(0, scan.lastMatchEnd);
              scanned = scanToolCalls(buffer);
              break;
            }
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

    const scan = scanned ?? scanToolCalls(buffer);
    const hasValidCall = scan.blocks.some((block) => block.kind === "call");

    if (!hasValidCall) {
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
          const visiblePreamble = stripToolCallMarkup(buffer);
          continuationPrefix += stripReasoningTags(visiblePreamble);
          incompleteToolCallBuffer = buffer.slice(visiblePreamble.length);
          truncatedCompletionRetries++;
          emptyCompletionRetries = 0;
          deferredVisibleText = "";
          continue;
        }
        const visiblePreamble = stripToolCallMarkup(
          continuationPrefix + stripReasoningTags(buffer),
        );
        if (visiblePreamble.trim()) {
          pushTurn({ role: "assistant", content: visiblePreamble });
        }
        pushTurn({
          role: "user",
          content: ABANDON_INCOMPLETE_TOOL_CALL_INSTRUCTION,
        });
        continuationPrefix = "";
        incompleteToolCallBuffer = "";
        emptyCompletionRetries = 0;
        truncatedCompletionRetries = 0;
        toolRounds++;
        if (toolRounds >= maxToolRounds) forceFinalResponse = true;
        hasCompletedRound = true;
        continue;
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

    let batchBuffer = buffer;
    let batchScan = scan;
    if (hasIncompleteToolCall(batchBuffer)) {
      // A trailing block is still cut off behind the complete ones. Retry as
      // an incomplete round rather than executing a partial batch; at the
      // retry cap, drop the unfinished tail and run what did arrive.
      if (truncatedCompletionRetries < MAX_TRUNCATED_COMPLETION_RETRIES) {
        const visiblePreamble = stripToolCallMarkup(batchBuffer);
        continuationPrefix += stripReasoningTags(visiblePreamble);
        incompleteToolCallBuffer = batchBuffer.slice(visiblePreamble.length);
        truncatedCompletionRetries++;
        emptyCompletionRetries = 0;
        deferredVisibleText = "";
        continue;
      }
      batchBuffer = batchBuffer.slice(0, batchScan.lastMatchEnd);
      batchScan = scanToolCalls(batchBuffer);
    }

    const blocks = batchScan.blocks;
    const firstBlockStart = blocks[0]!.matchStart;
    pushTurn({
      role: "assistant",
      content:
        continuationPrefix +
        stripReasoningTags(batchBuffer.slice(0, firstBlockStart)) +
        batchBuffer.slice(firstBlockStart, batchScan.lastMatchEnd),
    });
    continuationPrefix = "";
    incompleteToolCallBuffer = "";
    emptyCompletionRetries = 0;
    truncatedCompletionRetries = 0;
    toolRounds++;
    if (toolRounds >= maxToolRounds) forceFinalResponse = true;

    type BatchEntry = { name: string; status: string; body: string };
    const entries: BatchEntry[] = [];
    let skipReason: string | null = null;

    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]!;
      const blockName = block.kind === "call" ? block.call.name : "(unparseable)";

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
      const call = block.call;
      if (skipReason) {
        entries.push({ name: call.name, status: "skipped", body: skipReason });
        continue;
      }

      // findTool also returns undefined after a least-privilege transition
      // disabled tools mid-turn; the legacy message covers both cases.
      const tool = findTool(call.name);
      if (!tool) {
        entries.push({
          name: call.name,
          status: "error",
          body: `Tool "${call.name}" is not available.`,
        });
        continue;
      }

      const toolCallId = crypto.randomUUID();
      if (tool.parameters) {
        const validation = validateToolArgs(tool.parameters, call.args);
        if (!validation.ok) {
          const correction = formatArgIssues(
            tool.name,
            validation.issues,
            tool.parameters,
          );
          // Surface the rejected call so clients can show why nothing
          // executed; no permission prompt fires for a call that was never
          // dispatched.
          await emit({
            type: "tool_pending",
            toolCallId,
            name: tool.name,
            mutating: tool.mutating,
            kind: tool.kind,
            args: call.args,
          });
          await emit({
            type: "tool_update",
            toolCallId,
            status: "failed",
            output: correction,
          });
          entries.push({ name: call.name, status: "error", body: correction });
          continue;
        }
        call.args = validation.args;
      }

      await emit({
        type: "tool_pending",
        toolCallId,
        name: tool.name,
        mutating: tool.mutating,
        kind: tool.kind,
        args: call.args,
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
          (await requestPermission(toolCallId, tool, call.args));
        if (!allowed) {
          await emit({
            type: "tool_update",
            toolCallId,
            status: "failed",
            output: "Permission denied by user.",
          });
          entries.push({
            name: call.name,
            status: "rejected",
            body: "Tool call rejected by user.",
          });
          // A rejection usually invalidates the model's plan for the rest of
          // the batch — force a re-plan instead of running the remainder.
          skipReason =
            "Skipped: an earlier call in this batch was rejected by the user. Re-plan before retrying.";
          continue;
        }

        const result = await tool.execute(toolCtx, call.args);
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
          entries.push({
            name: call.name,
            status: "error",
            body: `Tool error: ${truncateToolOutput(result.error)}`,
          });
        } else {
          await emit({
            type: "tool_update",
            toolCallId,
            status: "completed",
            output: result.output,
            diff: result.diff,
          });
          entries.push({
            name: call.name,
            status: "ok",
            body: `Tool result: ${truncateToolOutput(result.output)}`,
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
        entries.push({
          name: call.name,
          status: "error",
          body: `Tool error: ${truncateToolOutput(message)}`,
        });
      }
    }

    pushTurn({ role: "user", content: formatBatchResults(entries) });
    hasCompletedRound = true;
  }
}

/**
 * A single call keeps the legacy "Tool result:"/"Tool error:" message shape
 * (stored sessions and context accounting key off those prefixes); multiple
 * calls come back numbered in one combined message.
 */
function formatBatchResults(
  entries: Array<{ name: string; status: string; body: string }>,
): string {
  if (entries.length === 1) return entries[0]!.body;
  const sections = entries.map(
    (entry, index) => `[${index + 1}] ${entry.name} → ${entry.status}\n${entry.body}`,
  );
  return `Tool results (${entries.length} calls):\n${sections.join("\n")}`;
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
