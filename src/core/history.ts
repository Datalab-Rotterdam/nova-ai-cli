import type { ChatMessage } from "@datalabrotterdam/nova-sdk";
import { chatContentToText } from "./chat-content.js";
import { parseToolArguments } from "./model/json-repair.js";
import { stripReasoningTags } from "./reasoning-tags.js";
import { scanToolCalls, stripToolCallMarkup } from "./tools/marker.js";

/**
 * Conversation history comes in two shapes that can be mixed in one session:
 * - native: assistant messages with `tool_calls` followed by `role: "tool"`
 *   results (models with a tool-call parser), and
 * - legacy text: ```tool_call blocks inside assistant text followed by a
 *   user message starting "Tool result:" / "Tool error:" / "Tool results (".
 * Everything that reads tool exchanges back out of history goes through here.
 */

export type NativeToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type HistoryToolCall = {
  /** Native call id; null for legacy text calls. */
  id: string | null;
  name: string;
  args: Record<string, unknown>;
};

export type ToolOutcome = {
  status: "completed" | "failed";
  output: string;
  /** Tool name from a legacy batch header; "(unparseable)" for malformed blocks. */
  name?: string;
};

const LEGACY_TOOL_RESULT =
  /^(?:Tool result:|Tool error:|Tool results \(|Tool call rejected by user\.)/;
const BATCH_HEADER = /^\[(\d+)\] (.+?) → (\w+)$/gm;

/** Native tool calls of an assistant message, ignoring malformed entries. */
export function nativeToolCalls(message: ChatMessage): NativeToolCall[] {
  const raw = (message as { tool_calls?: unknown }).tool_calls;
  if (message.role !== "assistant" || !Array.isArray(raw)) return [];
  const calls: NativeToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const call = item as Record<string, unknown>;
    const fn = call.function as Record<string, unknown> | undefined;
    if (typeof call.id !== "string" || !fn || typeof fn.name !== "string") {
      continue;
    }
    calls.push({
      id: call.id,
      type: "function",
      function: {
        name: fn.name,
        arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
      },
    });
  }
  return calls;
}

/** Tool calls an assistant message made, in either format. */
export function assistantToolCalls(message: ChatMessage): HistoryToolCall[] {
  if (message.role !== "assistant") return [];
  const native = nativeToolCalls(message);
  if (native.length) {
    return native.map((call) => ({
      id: call.id,
      name: call.function.name,
      args: parseToolArguments(call.function.arguments) ?? {},
    }));
  }
  return scanToolCalls(chatContentToText(message.content)).blocks.flatMap(
    (block) =>
      block.kind === "call"
        ? [{ id: null, name: block.call.name, args: block.call.args }]
        : [],
  );
}

/** Assistant text a person should see: no reasoning, no tool-call markup. */
export function assistantVisibleText(message: ChatMessage): string {
  return stripReasoningTags(
    stripToolCallMarkup(chatContentToText(message.content)),
  );
}

/** A tool result in either format (native `tool` role or legacy user text). */
export function isToolResultMessage(message: ChatMessage): boolean {
  if (message.role === "tool") return true;
  return (
    message.role === "user" &&
    LEGACY_TOOL_RESULT.test(chatContentToText(message.content))
  );
}

/** The body we store for one call, e.g. "Tool result: ..." → outcome. */
export function toolOutcomeFromBody(body: string): ToolOutcome {
  if (body.startsWith("Tool result:")) {
    return {
      status: "completed",
      output: body.slice("Tool result:".length).trimStart(),
    };
  }
  if (body.startsWith("Tool error:")) {
    return {
      status: "failed",
      output: body.slice("Tool error:".length).trimStart(),
    };
  }
  return { status: "failed", output: body };
}

/**
 * Outcomes in a legacy result message, in call order: a single
 * "Tool result:"-style message or a numbered "Tool results (N calls):" batch.
 * Returns null when the text is not a tool result at all.
 */
export function legacyToolOutcomes(text: string): ToolOutcome[] | null {
  if (text.startsWith("Tool results (")) {
    const headers = [...text.matchAll(BATCH_HEADER)];
    if (!headers.length) return null;
    return headers.map((header, index) => {
      const start = header.index! + header[0].length + 1;
      const end = headers[index + 1]?.index ?? text.length;
      const body = text.slice(start, end).replace(/\n$/, "");
      const outcome = toolOutcomeFromBody(body);
      return {
        status: header[3] === "ok" ? "completed" : "failed",
        output: outcome.output,
        name: header[2]!,
      };
    });
  }
  if (
    LEGACY_TOOL_RESULT.test(text) ||
    /^Tool "[^"]+" is not available\.$/.test(text) ||
    /^Tool call "[^"]+" has invalid arguments:/.test(text)
  ) {
    return [toolOutcomeFromBody(text)];
  }
  return null;
}

const INTERRUPTED_RESULT =
  "Tool error: No result was recorded for this call (the turn was interrupted).";

/**
 * Makes history safe to send with native tool calling: every assistant tool
 * call is answered by exactly one following `tool` message (synthesizing an
 * error for calls that never got a result, e.g. after a cancel), and `tool`
 * messages that answer no preceding call (e.g. cut off by compaction) are
 * kept as plain user text instead of being sent as orphans the API rejects.
 * Never mutates the input.
 */
export function sanitizeForNative(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (message.role === "tool") {
      result.push({
        role: "user",
        content: `[Earlier tool output]\n${chatContentToText(message.content)}`,
      });
      index++;
      continue;
    }
    const calls = nativeToolCalls(message);
    if (!calls.length) {
      result.push(message);
      index++;
      continue;
    }

    result.push(message);
    index++;
    const answered = new Set<string>();
    while (index < messages.length && messages[index]!.role === "tool") {
      const tool = messages[index]!;
      const id = (tool as { tool_call_id?: unknown }).tool_call_id;
      if (
        typeof id === "string" &&
        calls.some((call) => call.id === id) &&
        !answered.has(id)
      ) {
        answered.add(id);
        result.push(tool);
      } else {
        result.push({
          role: "user",
          content: `[Earlier tool output]\n${chatContentToText(tool.content)}`,
        });
      }
      index++;
    }
    for (const call of calls) {
      if (!answered.has(call.id)) {
        result.push({
          role: "tool",
          tool_call_id: call.id,
          content: INTERRUPTED_RESULT,
        });
      }
    }
  }
  return result;
}

/**
 * Rewrites native tool exchanges into the legacy text protocol, for models
 * that turned out not to support native tools. Legacy messages pass through.
 * Never mutates the input.
 */
export function toLegacyMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    const calls = nativeToolCalls(message);
    if (!calls.length && message.role !== "tool") {
      result.push(message);
      index++;
      continue;
    }

    if (calls.length) {
      const text = chatContentToText(message.content);
      const blocks = calls.map(
        (call) =>
          `\`\`\`tool_call\n${JSON.stringify({
            name: call.function.name,
            args: parseToolArguments(call.function.arguments) ?? {},
          })}\n\`\`\``,
      );
      const { tool_calls: _ignored, ...rest } = message as ChatMessage & {
        tool_calls?: unknown;
      };
      result.push({
        ...rest,
        role: "assistant",
        content: [text, ...blocks].filter(Boolean).join("\n"),
      });
      index++;
    }

    const results: Array<{ name: string; body: string }> = [];
    while (index < messages.length && messages[index]!.role === "tool") {
      const tool = messages[index]!;
      const id = (tool as { tool_call_id?: unknown }).tool_call_id;
      results.push({
        name: calls.find((call) => call.id === id)?.function.name ?? "tool",
        body: chatContentToText(tool.content),
      });
      index++;
    }
    if (results.length === 1) {
      result.push({ role: "user", content: results[0]!.body });
    } else if (results.length > 1) {
      const sections = results.map((entry, position) => {
        const status = entry.body.startsWith("Tool result:") ? "ok" : "error";
        return `[${position + 1}] ${entry.name} → ${status}\n${entry.body}`;
      });
      result.push({
        role: "user",
        content: `Tool results (${results.length} calls):\n${sections.join("\n")}`,
      });
    }
  }
  return result;
}

/** Plain-text rendering used for token estimates and summaries. */
export function messageTextWithToolCalls(message: ChatMessage): string {
  const text = chatContentToText(message.content);
  const calls = nativeToolCalls(message);
  if (!calls.length) return text;
  const rendered = calls.map(
    (call) => `[tool call] ${call.function.name} ${call.function.arguments}`,
  );
  return [text, ...rendered].filter(Boolean).join("\n");
}

export type ReplayItem =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | {
      kind: "tool";
      name: string;
      args: Record<string, unknown>;
      status: "completed" | "failed";
      output: string;
    };

const NOT_PERSISTED = "Tool result was not persisted before the session ended.";

/**
 * The conversation as a person saw it: user and agent text plus every tool
 * call with its final status, rebuilt from history in either format. Tool
 * results are never shown as user messages. Used to replay a loaded session
 * to ACP clients and to restore the TUI transcript.
 */
export function replayHistory(messages: ChatMessage[]): ReplayItem[] {
  const items: ReplayItem[] = [];
  // Calls of the latest assistant message still waiting for their result.
  let pending: Array<{ id: string | null; item: Extract<ReplayItem, { kind: "tool" }> }> = [];
  const settleMissing = () => {
    for (const { item } of pending) {
      item.status = "failed";
      item.output = NOT_PERSISTED;
    }
    pending = [];
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      settleMissing();
      const visible = assistantVisibleText(message);
      if (visible.trim()) items.push({ kind: "agent", text: visible });
      for (const call of assistantToolCalls(message)) {
        const item = {
          kind: "tool" as const,
          name: call.name,
          args: call.args,
          status: "failed" as "completed" | "failed",
          output: NOT_PERSISTED,
        };
        items.push(item);
        pending.push({ id: call.id, item });
      }
      continue;
    }

    if (message.role === "tool") {
      const id = (message as { tool_call_id?: unknown }).tool_call_id;
      const index = pending.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        const outcome = toolOutcomeFromBody(chatContentToText(message.content));
        pending[index]!.item.status = outcome.status;
        pending[index]!.item.output = outcome.output;
        pending.splice(index, 1);
      }
      continue;
    }

    if (message.role !== "user") continue;
    const text = chatContentToText(message.content);
    const outcomes = pending.length ? legacyToolOutcomes(text) : null;
    if (outcomes) {
      const forCalls = outcomes.filter((outcome) => outcome.name !== "(unparseable)");
      forCalls.forEach((outcome, index) => {
        const entry = pending[index];
        if (entry) {
          entry.item.status = outcome.status;
          entry.item.output = outcome.output;
        }
      });
      pending = pending.slice(forCalls.length);
      settleMissing();
      continue;
    }
    settleMissing();
    // A legacy tool result whose call was lost (e.g. compacted) is not user text.
    if (LEGACY_TOOL_RESULT.test(text)) continue;
    if (text.trim()) items.push({ kind: "user", text });
  }

  settleMissing();
  return items;
}
