// Ported from nova-ai-vscode src/model/textToolCalls.ts (kept in sync by hand).
// Local additions: the ```tool_call fence format and the `args` key.
import { parseToolArguments, repairJson } from "./json-repair.js";

export interface TagStreamHandlers {
  /** Text outside of tags, emitted as soon as it cannot be the start of an opening tag. */
  outside(text: string): void;
  /** Text inside tags. Emitted incrementally when `incremental` is set, otherwise once per complete block. */
  inside(text: string, complete: boolean): void;
  /** Called when an opening tag is found, before any of its content. */
  open?(): void;
}

/**
 * Splits a streamed string on an opening and closing tag, holding back partial tags
 * across chunk boundaries. A missing closing tag at the end of the stream yields the
 * remaining text as an incomplete block.
 */
export class TagStream {
  private buffer = "";
  private insideTag = false;

  public constructor(
    private readonly openTag: string,
    private readonly closeTag: string | undefined,
    private readonly handlers: TagStreamHandlers,
    private readonly incremental = false
  ) {
  }

  public push(text: string): void {
    this.buffer += text;
    this.drain(false);
  }

  public end(): void {
    this.drain(true);
  }

  private drain(final: boolean): void {
    for (;;) {
      if (!this.insideTag) {
        const start = this.buffer.indexOf(this.openTag);
        if (start >= 0) {
          this.emitOutside(this.buffer.slice(0, start));
          this.buffer = this.buffer.slice(start + this.openTag.length);
          this.insideTag = true;
          this.handlers.open?.();
          continue;
        }

        const keep = final ? 0 : partialSuffixLength(this.buffer, this.openTag);
        this.emitOutside(this.buffer.slice(0, this.buffer.length - keep));
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        return;
      }

      const end = this.closeTag ? this.buffer.indexOf(this.closeTag) : -1;
      if (end >= 0 && this.closeTag) {
        this.handlers.inside(this.buffer.slice(0, end), true);
        this.buffer = this.buffer.slice(end + this.closeTag.length);
        this.insideTag = false;
        continue;
      }

      if (final) {
        if (this.buffer || !this.incremental) {
          this.handlers.inside(this.buffer, false);
        }
        this.buffer = "";
      } else if (this.incremental) {
        const keep = this.closeTag ? partialSuffixLength(this.buffer, this.closeTag) : 0;
        const ready = this.buffer.slice(0, this.buffer.length - keep);
        if (ready) {
          this.handlers.inside(ready, false);
        }
        this.buffer = this.buffer.slice(this.buffer.length - keep);
      }
      return;
    }
  }

  private emitOutside(text: string): void {
    if (text) {
      this.handlers.outside(text);
    }
  }
}

/** Length of the longest suffix of `text` that is a proper prefix of `tag`. */
function partialSuffixLength(text: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(tag.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

export interface TextToolCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Formats in which models write tool calls into the message text when the server's
 * tool-call parser is not enabled: Hermes/Qwen `<tool_call>…</tool_call>`, Mistral
 * `[TOOL_CALLS][…]` and Llama `<|python_tag|>{…}` (both run until the end of the message).
 */
export const TEXT_TOOL_CALL_FORMATS: ReadonlyArray<{ open: string; close?: string }> = [
  // nova-ai-cli's own text protocol: a model resuming a session whose history
  // shows this format may keep using it even when native tools are offered.
  // Valid JSON cannot hold a raw newline inside a string, so "\n```" closes it.
  { open: "```tool_call", close: "\n```" },
  { open: "<tool_call>", close: "</tool_call>" },
  { open: "[TOOL_CALLS]" },
  { open: "<|python_tag|>" }
];

/**
 * Parses a text tool-call block into calls for known tools. Returns undefined when the
 * block is not valid or names a tool that was not offered, so the caller can emit it as text.
 */
export function parseTextToolCalls(block: string, isKnownTool: (name: string) => boolean): TextToolCall[] | undefined {
  const parsed = parseJsonValue(block);
  const items = Array.isArray(parsed) ? parsed : parsed === undefined ? [] : [parsed];
  const calls: TextToolCall[] = [];

  for (const item of items) {
    if (!isRecord(item)) {
      return undefined;
    }

    const fn = isRecord(item.function) ? item.function : item;
    const name = typeof fn.name === "string" ? fn.name : undefined;
    const rawArguments = fn.arguments ?? fn.parameters ?? fn.args ?? {};
    const input = typeof rawArguments === "string"
      ? parseToolArguments(rawArguments)
      : isRecord(rawArguments) ? rawArguments : undefined;

    if (!name || !isKnownTool(name) || !input) {
      return undefined;
    }
    calls.push({ name, input });
  }

  return calls.length ? calls : undefined;
}

function parseJsonValue(text: string): unknown {
  for (const candidate of [text.trim(), repairJson(text)]) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Removes stand-alone special tokens (end-of-turn markers and the like) from streamed text,
 * holding back partial tokens across chunk boundaries.
 */
export class TokenFilter {
  private buffer = "";

  public constructor(
    private readonly tokens: readonly string[],
    private readonly emit: (text: string) => void
  ) {
  }

  public push(text: string): void {
    this.buffer += text;
    this.drain(false);
  }

  public end(): void {
    this.drain(true);
  }

  private drain(final: boolean): void {
    for (const token of this.tokens) {
      this.buffer = this.buffer.split(token).join("");
    }
    const keep = final ? 0 : Math.max(0, ...this.tokens.map((token) => partialSuffixLength(this.buffer, token)));
    const ready = this.buffer.slice(0, this.buffer.length - keep);
    this.buffer = this.buffer.slice(this.buffer.length - keep);
    if (ready) {
      this.emit(ready);
    }
  }
}
