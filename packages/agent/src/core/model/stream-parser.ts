// Ported from nova-ai-vscode src/model/streamParser.ts (kept in sync by hand).
import type { ChatCompletionChunk } from "@datalabrotterdam/nova-sdk";
import { isCompleteJson, parseToolArguments } from "./json-repair.js";
import { parseTextToolCalls, TagStream, TEXT_TOOL_CALL_FORMATS, TokenFilter } from "./text-tool-calls.js";
import type { ToolNameMap } from "./tool-schema.js";

/**
 * Reasoning that servers without a reasoning parser leave in the content:
 * `<think>` (DeepSeek, Qwen), Gemma 4 channels and gpt-oss "harmony" analysis channels.
 */
const REASONING_FORMATS: ReadonlyArray<{ open: string; close: string; label?: RegExp }> = [
  { open: "<think>", close: "</think>" },
  { open: "<|channel>", close: "<channel|>", label: /^\s*thought\s*\n?/ },
  { open: "<|channel|>analysis<|message|>", close: "<|end|>" }
];

/** End-of-turn and channel markers that should never be shown. */
const STRAY_TOKENS = [
  "<|start|>assistant<|channel|>final<|message|>", "<|channel|>final<|message|>", "<|return|>", "<|end|>",
  "<turn|>", "<|turn>model", "<end_of_turn>", "<|im_end|>", "<|eot_id|>", "<|endoftext|>"
];

export interface StreamSink {
  text(value: string): void;
  thinking(value: string): void;
  toolCall(callId: string, name: string, input: Record<string, unknown>): void;
}

export interface StreamParserOptions {
  /** Unique per request, so generated call ids never collide across tool rounds. */
  callIdPrefix: string;
  /** Names of the tools offered in this request; empty when no tools were offered. */
  toolNames: ToolNameMap;
}

interface PendingToolCall {
  id?: string;
  name: string;
  argumentsText: string;
}

/**
 * Turns streamed chat-completion chunks into text, thinking and tool-call parts.
 *
 * - Native `tool_calls` deltas are accumulated per index and flushed on `finish_reason`
 *   or at the end of the stream, with JSON repair for sloppy arguments.
 * - `reasoning_content` deltas and `<think>` blocks are routed to `thinking`.
 * - Tool calls written as text (`<tool_call>`, `[TOOL_CALLS]`, `<|python_tag|>`) are
 *   converted to real tool calls when they name an offered tool.
 */
export class ChatStreamParser {
  public readonly finishReasons: string[] = [];
  public readonly invalidToolCalls: string[] = [];
  public receivedText = false;
  public receivedToolCalls = false;

  private readonly pending = new Map<number, PendingToolCall>();
  private generatedIds = 0;
  /** Content passes through these stages in order; the last stage emits visible text. */
  private readonly stages: Array<{ push(text: string): void; end(): void }> = [];

  public constructor(
    private readonly options: StreamParserOptions,
    private readonly sink: StreamSink
  ) {
    // Built back to front: reasoning blocks → stray special tokens → text tool calls → visible text.
    let next = (text: string) => this.emitText(text);
    const stages: Array<{ push(text: string): void; end(): void }> = [];
    const prepend = (stage: { push(text: string): void; end(): void }) => {
      stages.unshift(stage);
      next = (text) => stage.push(text);
    };

    if (options.toolNames.size) {
      for (const format of [...TEXT_TOOL_CALL_FORMATS].reverse()) {
        const emitAsText = next;
        prepend(new TagStream(format.open, format.close, {
          outside: emitAsText,
          inside: (block) => this.handleTextToolBlock(block, format, emitAsText)
        }));
      }
    }

    prepend(new TokenFilter(STRAY_TOKENS, next));

    for (const format of [...REASONING_FORMATS].reverse()) {
      const outside = next;
      // Holds the start of a block until its channel label (Gemma's "thought\n") can be stripped.
      let pendingLabel: string | undefined;
      prepend(new TagStream(format.open, format.close, {
        outside,
        open: () => (pendingLabel = format.label ? "" : undefined),
        inside: (text, complete) => {
          let value = text;
          if (pendingLabel !== undefined && format.label) {
            pendingLabel += text;
            if (!complete && pendingLabel.length < 16 && !pendingLabel.includes("\n")) {
              return;
            }
            value = pendingLabel.replace(format.label, "");
            pendingLabel = undefined;
          }
          if (value) {
            this.sink.thinking(value);
          }
        }
      }, true));
    }

    this.stages = stages;
  }

  public pushChunk(chunk: ChatCompletionChunk): void {
    for (const choice of chunk.choices ?? []) {
      const delta = (choice.delta ?? {}) as Record<string, unknown>;

      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        this.sink.thinking(reasoning);
      }

      if (typeof delta.content === "string" && delta.content) {
        this.stages[0].push(delta.content);
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) {
          if (isRecord(toolCall)) {
            this.accumulateToolCall(toolCall);
          }
        }
      }

      if (choice.finish_reason) {
        this.finishReasons.push(choice.finish_reason);
        if (choice.finish_reason === "tool_calls") {
          this.flushToolCalls();
        }
      }
    }
  }

  public end(): void {
    for (const stage of this.stages) {
      stage.end();
    }
    this.flushToolCalls();
  }

  private emitText(text: string): void {
    if (!text) {
      return;
    }
    this.receivedText = true;
    this.sink.text(text);
  }

  private accumulateToolCall(toolCall: Record<string, unknown>): void {
    const index = this.resolveIndex(toolCall);
    const current = this.pending.get(index) ?? { name: "", argumentsText: "" };

    if (typeof toolCall.id === "string" && toolCall.id) {
      current.id ??= toolCall.id;
    }

    const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
    if (fn && typeof fn.name === "string" && fn.name) {
      current.name = fn.name;
    }

    const args = fn?.arguments;
    if (isRecord(args)) {
      current.argumentsText = JSON.stringify(args);
    } else if (typeof args === "string" && args) {
      current.argumentsText = mergeArguments(current.argumentsText, args);
    }

    this.pending.set(index, current);
  }

  private resolveIndex(toolCall: Record<string, unknown>): number {
    if (typeof toolCall.index === "number") {
      return toolCall.index;
    }

    // Some servers omit the index: match by id, or continue the latest call.
    const entries = Array.from(this.pending.entries());
    if (typeof toolCall.id === "string") {
      const match = entries.find(([, pending]) => pending.id === toolCall.id);
      return match ? match[0] : (entries.length ? Math.max(...entries.map(([key]) => key)) + 1 : 0);
    }
    return entries.length ? entries[entries.length - 1][0] : 0;
  }

  private flushToolCalls(): void {
    const entries = Array.from(this.pending.entries()).sort(([left], [right]) => left - right);
    this.pending.clear();

    for (const [, toolCall] of entries) {
      if (!toolCall.name) {
        continue;
      }

      const input = parseToolArguments(toolCall.argumentsText);
      const name = this.options.toolNames.fromNova(toolCall.name) ?? toolCall.name;
      if (!input) {
        this.invalidToolCalls.push(name);
        this.emitText(`\n\n_Nova skipped a call to \`${name}\` because the model produced invalid arguments._\n`);
        continue;
      }

      this.emitToolCall(toolCall.id, name, input);
    }
  }

  private handleTextToolBlock(
    block: string,
    format: { open: string; close?: string },
    emitAsText: (text: string) => void
  ): void {
    const calls = parseTextToolCalls(block, (name) => this.options.toolNames.fromNova(name) !== undefined);
    if (!calls) {
      emitAsText(`${format.open}${block}${format.close ?? ""}`);
      return;
    }

    for (const call of calls) {
      this.emitToolCall(undefined, this.options.toolNames.fromNova(call.name) ?? call.name, call.input);
    }
  }

  private emitToolCall(id: string | undefined, name: string, input: Record<string, unknown>): void {
    this.receivedToolCalls = true;
    this.sink.toolCall(id ?? `${this.options.callIdPrefix}-${this.generatedIds++}`, name, input);
  }
}

/**
 * Appends an arguments delta. Some servers resend the complete arguments in every
 * chunk instead of a delta; once the accumulated text is complete JSON, a chunk that
 * repeats or extends it replaces it instead of being appended.
 */
function mergeArguments(current: string, chunk: string): string {
  if (current && isCompleteJson(current) && chunk.startsWith(current)) {
    return chunk;
  }
  return current + chunk;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
