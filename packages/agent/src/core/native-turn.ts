import type { ChatMessage } from "@datalabrotterdam/nova-sdk";
import {
  isContextLimitError,
  type ContextCompactionResult,
} from "./context-compaction.js";
import { estimateMessagesTokens } from "./context-usage.js";
import { sanitizeForNative, type NativeToolCall } from "./history.js";
import { ChatStreamParser } from "./model/stream-parser.js";
import { buildToolPayload } from "./model/tool-schema.js";
import {
  isToolCallingRejected,
  ToolCallingUnsupportedError,
} from "./model/tool-support.js";
import type { RunTurnDeps, RunTurnResult } from "./run-turn.js";
import { runToolBatch, type BatchEntry } from "./tool-batch.js";

const DEFAULT_MAX_TOOL_ROUNDS = 64;
const MAX_EMPTY_COMPLETION_RETRIES = 2;
const MAX_TRUNCATED_COMPLETION_RETRIES = 2;
const PROACTIVE_COMPACTION_THRESHOLD = 0.8;
const EMPTY_COMPLETION_INSTRUCTION =
  "The previous completion contained no visible assistant response. Continue the task now with either the next required tool call or a final answer.";
const TRUNCATED_COMPLETION_INSTRUCTION =
  "Your previous response was cut off. Continue exactly where it stopped. Do not restart, repeat the preamble, or claim completion without providing the actual result.";
const TRUNCATED_TOOL_CALL_INSTRUCTION =
  "Your previous response was cut off while writing tool call arguments, so none of those calls were executed. Do not retry the same large call. Split the work into smaller tool calls (for large files, write them in parts or use edit_file), or answer with the results already gathered.";
const FINAL_RESPONSE_INSTRUCTION =
  "The tool-use safety limit has been reached. Do not call any more tools. Return a final answer now using the results already gathered, and clearly mention anything that remains unverified.";

type StreamedCall = { id: string; name: string; input: Record<string, unknown> };

/**
 * The model ↔ tool loop for models with native (OpenAI-style) tool calling.
 * Tools travel in the request's `tools` field, calls come back as
 * `tool_calls` deltas (or as Hermes/Mistral/Llama text blocks, which the
 * stream parser converts), and every call is answered by one `tool` message
 * carrying its tool_call_id.
 *
 * If the server rejects `tools` before anything happened in this turn, a
 * ToolCallingUnsupportedError is thrown with `messages` untouched, so the
 * caller can retry the turn with the text protocol.
 */
export async function runNativeTurn(
  messages: ChatMessage[],
  signal: AbortSignal,
  deps: RunTurnDeps,
): Promise<RunTurnResult> {
  const { compactContext, takeSteeringMessages, emit, novaClient, model } =
    deps;
  const maxToolRounds = Math.max(
    1,
    deps.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
  );
  let toolsEnabled = true;
  const findTool = (name: string) =>
    toolsEnabled ? deps.tools.find((tool) => tool.name === name) : undefined;
  const turnMessages: ChatMessage[] = [];
  const pushTurn = (message: ChatMessage) => {
    messages.push(message);
    turnMessages.push(message);
  };

  let contextCompactionUsed = false;
  let proactiveCompactionUsed = false;
  let toolRounds = 0;
  let emptyRetries = 0;
  let truncatedRetries = 0;
  let continuationPrefix = "";
  let forceFinalResponse = false;
  let hasCompletedRound = false;
  let anythingHappened = false;

  while (true) {
    if (signal.aborted) return { stopReason: "cancelled", turnMessages };

    if (hasCompletedRound && takeSteeringMessages) {
      for (const message of await takeSteeringMessages()) pushTurn(message);
    }
    hasCompletedRound = false;

    if (
      !proactiveCompactionUsed &&
      compactContext &&
      typeof deps.contextWindow === "number" &&
      deps.contextWindow > 0 &&
      estimateMessagesTokens(messages) >
        deps.contextWindow * (deps.compactThreshold ?? PROACTIVE_COMPACTION_THRESHOLD)
    ) {
      proactiveCompactionUsed = true;
      await runCompaction(compactContext, messages, null, emit);
    }

    const payload = buildToolPayload(toolsEnabled ? deps.tools : []);
    const instruction = continuationPrefix
      ? forceFinalResponse
        ? `${TRUNCATED_COMPLETION_INSTRUCTION} ${FINAL_RESPONSE_INSTRUCTION}`
        : TRUNCATED_COMPLETION_INSTRUCTION
      : forceFinalResponse
        ? FINAL_RESPONSE_INSTRUCTION
        : emptyRetries > 0
          ? EMPTY_COMPLETION_INSTRUCTION
          : null;
    const requestMessages = sanitizeForNative([
      ...messages,
      ...(continuationPrefix
        ? [{ role: "assistant" as const, content: continuationPrefix }]
        : []),
      ...(instruction ? [{ role: "user" as const, content: instruction }] : []),
    ]);

    let text = "";
    const calls: StreamedCall[] = [];
    let finishReason: string | null = null;
    let reportedUsage: { promptTokens: number; completionTokens: number } | null = null;
    // Parser callbacks are synchronous; their emits are awaited per chunk so
    // client notifications keep the stream's order and backpressure.
    let pending: Array<void | Promise<void>> = [];
    const flush = async () => {
      const batch = pending;
      pending = [];
      for (const item of batch) await item;
    };
    const parser = new ChatStreamParser(
      {
        callIdPrefix: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
        toolNames: payload.names,
      },
      {
        text: (value) => {
          text += value;
          anythingHappened = true;
          pending.push(emit({ type: "text", text: value }));
        },
        thinking: (value) => {
          pending.push(emit({ type: "thought", text: value }));
        },
        toolCall: (id, name, input) => {
          anythingHappened = true;
          calls.push({ id, name, input });
        },
      },
    );
    try {
      for await (const event of novaClient.chat.completions.stream(
        {
          model,
          messages: requestMessages,
          stream_options: { include_usage: true },
          ...(payload.tools.length
            ? {
                tools: payload.tools,
                tool_choice: forceFinalResponse ? "none" : "auto",
              }
            : {}),
        },
        { signal },
      )) {
        if (event.type !== "chunk") continue;
        const usage = event.data.usage;
        if (usage && typeof usage.prompt_tokens === "number") {
          reportedUsage = {
            promptTokens: usage.prompt_tokens,
            completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
          };
        }
        for (const choice of event.data.choices ?? []) {
          if (typeof choice.finish_reason === "string") {
            finishReason = choice.finish_reason;
          }
        }
        parser.pushChunk(event.data);
        await flush();
      }
      parser.end();
      await flush();
      if (reportedUsage) await emit({ type: "usage", ...reportedUsage });
    } catch (error) {
      await flush().catch(() => {});
      if (signal.aborted) return { stopReason: "cancelled", turnMessages };
      if (
        isToolCallingRejected(error) &&
        payload.tools.length &&
        !anythingHappened &&
        turnMessages.length === 0
      ) {
        throw new ToolCallingUnsupportedError(error);
      }
      if (
        !contextCompactionUsed &&
        !text &&
        !calls.length &&
        compactContext &&
        isContextLimitError(error)
      ) {
        contextCompactionUsed = true;
        if (await runCompaction(compactContext, messages, error, emit)) {
          continue;
        }
      }
      throw error;
    }

    const truncated =
      finishReason !== null &&
      ["length", "max_tokens", "max_output_tokens"].includes(
        finishReason.toLowerCase(),
      );

    if (calls.length && truncated) {
      // Arguments may be cut mid-value (half a file for write_file): never
      // execute them. Keep what was said and ask for smaller calls.
      const said = continuationPrefix + text;
      if (said.trim()) pushTurn({ role: "assistant", content: said });
      pushTurn({ role: "user", content: TRUNCATED_TOOL_CALL_INSTRUCTION });
      continuationPrefix = "";
      emptyRetries = 0;
      truncatedRetries = 0;
      toolRounds++;
      if (toolRounds >= maxToolRounds) forceFinalResponse = true;
      hasCompletedRound = true;
      continue;
    }

    if (!calls.length) {
      if (!text.trim()) {
        if (emptyRetries < MAX_EMPTY_COMPLETION_RETRIES) {
          emptyRetries++;
          continue;
        }
        throw new Error(
          forceFinalResponse
            ? "The model did not provide a final response after reaching the tool-use safety limit."
            : `The model returned no visible assistant content after ${MAX_EMPTY_COMPLETION_RETRIES + 1} attempts.`,
        );
      }
      if (truncated) {
        if (truncatedRetries < MAX_TRUNCATED_COMPLETION_RETRIES) {
          continuationPrefix += text;
          truncatedRetries++;
          emptyRetries = 0;
          continue;
        }
        throw new Error(
          `The model response remained incomplete after ${MAX_TRUNCATED_COMPLETION_RETRIES + 1} attempts (finish reason ${finishReason}).`,
        );
      }
      pushTurn({ role: "assistant", content: continuationPrefix + text });
      return {
        stopReason: forceFinalResponse ? "max_turn_requests" : "end_turn",
        turnMessages,
      };
    }

    if (forceFinalResponse) {
      // tool_choice "none" was ignored; do not run more tools.
      if (emptyRetries < MAX_EMPTY_COMPLETION_RETRIES) {
        emptyRetries++;
        hasCompletedRound = true;
        continue;
      }
      throw new Error(
        "The model kept requesting tools after reaching the tool-use safety limit and did not provide a final response.",
      );
    }

    const toolCalls: NativeToolCall[] = calls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: payload.names.toNova(call.name),
        arguments: JSON.stringify(call.input),
      },
    }));
    pushTurn({
      role: "assistant",
      content: continuationPrefix + text,
      tool_calls: toolCalls,
    });
    continuationPrefix = "";
    emptyRetries = 0;
    truncatedRetries = 0;
    toolRounds++;
    if (toolRounds >= maxToolRounds) forceFinalResponse = true;

    const entries: BatchEntry[] = [];
    try {
      await runToolBatch(
        calls.map((call) => ({
          kind: "call" as const,
          name: call.name,
          args: call.input,
        })),
        {
          host: deps.host,
          sessionId: deps.sessionId,
          cwd: deps.cwd,
          environment: deps.environment,
          background: deps.background,
          signal,
          findTool,
          requestPermission: deps.requestPermission,
          authorize: deps.authorize,
          emit,
          disableTools: () => {
            toolsEnabled = false;
          },
        },
        entries,
      );
    } catch (error) {
      // Cancelled mid-batch: calls that finished keep their real result (the
      // work happened), the rest are answered as cancelled, so the stored
      // history stays valid for the next request.
      answerCalls(toolCalls, entries, pushTurn);
      if (signal.aborted) return { stopReason: "cancelled", turnMessages };
      throw error;
    }

    answerCalls(toolCalls, entries, pushTurn);
    hasCompletedRound = true;
  }
}

function answerCalls(
  toolCalls: NativeToolCall[],
  entries: BatchEntry[],
  pushTurn: (message: ChatMessage) => void,
): void {
  toolCalls.forEach((call, index) => {
    pushTurn({
      role: "tool",
      tool_call_id: call.id,
      content:
        entries[index]?.body ??
        "Tool error: Cancelled before this call completed.",
    });
  });
}

async function runCompaction(
  compactContext: NonNullable<RunTurnDeps["compactContext"]>,
  messages: ChatMessage[],
  error: unknown,
  emit: RunTurnDeps["emit"],
): Promise<boolean> {
  let result: ContextCompactionResult | null = null;
  try {
    result = await compactContext(messages, error);
  } catch (compactionError) {
    // Proactive compaction is an optimization; the reactive path surfaces
    // the original context-limit error rather than this secondary failure.
    await emit({
      type: "context_compaction_failed",
      reason:
        compactionError instanceof Error
          ? compactionError.message
          : "Unknown compaction error.",
    });
    return false;
  }
  if (result?.compacted) {
    await emit({
      type: "context_compacted",
      removedMessages: result.removedMessages,
      keptMessages: result.keptMessages,
    });
    return true;
  }
  return false;
}
