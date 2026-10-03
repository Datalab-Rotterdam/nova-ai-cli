export type ParsedToolCall = {
  name: string;
  args: Record<string, unknown>;
  matchStart: number;
  matchEnd: number;
};

export type ToolCallBlock =
  | { kind: "call"; call: ParsedToolCall; matchStart: number; matchEnd: number }
  | { kind: "malformed"; matchStart: number; matchEnd: number };

export type ToolCallScan = {
  blocks: ToolCallBlock[];
  /** End offset of the last complete block; 0 when there are none. */
  lastMatchEnd: number;
};

const SENTINEL_START = "<|tool_call>";
const SENTINEL_END = "<tool_call|>";
const FENCE_CLOSE = "\n```";

/**
 * Scans the buffer for every complete tool-call block (fenced or sentinel),
 * in order. A trailing block whose closing marker hasn't streamed in yet is
 * not returned — the caller keeps buffering until it completes or the stream
 * ends.
 */
export function scanToolCalls(buffer: string): ToolCallScan {
  const blocks: ToolCallBlock[] = [];
  let position = 0;
  while (position < buffer.length) {
    const fenceIndex = buffer.indexOf(FENCE_START, position);
    const sentinelIndex = buffer.indexOf(SENTINEL_START, position);
    if (fenceIndex === -1 && sentinelIndex === -1) break;
    const useFence =
      fenceIndex !== -1 && (sentinelIndex === -1 || fenceIndex < sentinelIndex);
    const block = useFence
      ? scanFencedBlock(buffer, fenceIndex)
      : scanSentinelBlock(buffer, sentinelIndex);
    if (!block) break;
    blocks.push(block);
    position = block.matchEnd;
  }
  return { blocks, lastMatchEnd: blocks.at(-1)?.matchEnd ?? 0 };
}

function scanFencedBlock(buffer: string, start: number): ToolCallBlock | null {
  // Opening marker, optional inline whitespace, then a newline.
  let cursor = start + FENCE_START.length;
  while (
    cursor < buffer.length &&
    buffer[cursor] !== "\n" &&
    /\s/.test(buffer[cursor]!)
  ) {
    cursor++;
  }
  if (cursor >= buffer.length || buffer[cursor] !== "\n") return null;
  const payloadStart = cursor + 1;

  // Brace-scan the payload first (string-aware), so a ``` embedded inside the
  // JSON never closes the block early; only then look for the closing fence.
  const jsonText = extractFirstJsonObject(buffer.slice(payloadStart));
  if (jsonText === null) {
    const close = buffer.indexOf(FENCE_CLOSE, payloadStart);
    if (close === -1) return null;
    return {
      kind: "malformed",
      matchStart: start,
      matchEnd: close + FENCE_CLOSE.length,
    };
  }
  const jsonStart = buffer.indexOf("{", payloadStart);
  const jsonEnd = jsonStart + jsonText.length;
  const close = buffer.indexOf(FENCE_CLOSE, jsonEnd);
  if (close === -1) return null;
  const matchEnd = close + FENCE_CLOSE.length;
  const call = parseCallPayload(jsonText, start, matchEnd);
  return call
    ? { kind: "call", call, matchStart: start, matchEnd }
    : { kind: "malformed", matchStart: start, matchEnd };
}

function scanSentinelBlock(
  buffer: string,
  start: number,
): ToolCallBlock | null {
  const end = buffer.indexOf(SENTINEL_END, start + SENTINEL_START.length);
  if (end === -1) return null;
  const matchEnd = end + SENTINEL_END.length;
  const payload = buffer.slice(start + SENTINEL_START.length, end).trim();
  const call = /^call:([^:\s]+):\s*([\s\S]+)$/.exec(payload);
  const args = call?.[1] && call[2] ? parseLooseObject(call[2]) : null;
  if (!call?.[1] || !args) {
    return { kind: "malformed", matchStart: start, matchEnd };
  }
  return {
    kind: "call",
    call: { name: call[1], args, matchStart: start, matchEnd },
    matchStart: start,
    matchEnd,
  };
}

function parseCallPayload(
  jsonText: string,
  matchStart: number,
  matchEnd: number,
): ParsedToolCall | null {
  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed?.name !== "string") return null;
    return {
      name: parsed.name,
      args: unwrapArgs(
        typeof parsed.args === "object" && parsed.args !== null
          ? parsed.args
          : parsed,
      ),
      matchStart,
      matchEnd,
    };
  } catch {
    return null;
  }
}

/**
 * Looks for the first complete, valid tool-call block in the accumulated
 * stream buffer. Returns null while no block has fully arrived yet (it may
 * be split across multiple stream chunks).
 */
export function extractToolCall(buffer: string): ParsedToolCall | null {
  for (const block of scanToolCalls(buffer).blocks) {
    if (block.kind === "call") return block.call;
  }
  return null;
}

/**
 * True while the tail could still grow into (more of) a tool-call block:
 * it is whitespace, contains a start marker, or ends with a prefix of one.
 * Used to keep buffering consecutive blocks instead of cutting the stream
 * after the first complete call.
 */
export function tailMayContinueToolCalls(tail: string): boolean {
  return tail.trim() === "" || hasPendingFence(tail);
}

/**
 * Models occasionally double-wrap the payload, e.g. {"args": {"args": {...}}}.
 * Unwrap that one level so the tool still receives its real arguments
 * instead of an object whose only key is "args".
 */
function unwrapArgs(args: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(args);
  if (
    keys.length === 1 &&
    keys[0] === "args" &&
    typeof args.args === "object" &&
    args.args !== null
  ) {
    return args.args as Record<string, unknown>;
  }
  return args;
}

/**
 * True when at least one complete tool-call block is present but none of
 * them parse into a valid call — distinct from "no tool call at all" so the
 * caller can feed the model a correction instead of treating a botched tool
 * call as the model's final answer.
 */
export function hasMalformedToolCall(buffer: string): boolean {
  const { blocks } = scanToolCalls(buffer);
  return (
    blocks.length > 0 && blocks.every((block) => block.kind === "malformed")
  );
}

/**
 * True after a tool marker starts but before its closing marker arrives.
 * With multiple blocks, only a start marker AFTER the last complete block
 * counts — earlier markers are all inside finished blocks.
 */
export function hasIncompleteToolCall(buffer: string): boolean {
  const { lastMatchEnd } = scanToolCalls(buffer);
  return TOOL_CALL_STARTS.some(
    (start) => buffer.indexOf(start, lastMatchEnd) !== -1,
  );
}

/** Removes complete or partial tool markup from restored assistant text. */
export function stripToolCallMarkup(buffer: string): string {
  const starts = TOOL_CALL_STARTS.flatMap((start) => {
    const index = buffer.indexOf(start);
    return index >= 0 ? [index] : [];
  });
  return starts.length ? buffer.slice(0, Math.min(...starts)) : buffer;
}

/**
 * Models sometimes emit malformed trailing characters after the JSON object
 * (e.g. an extra closing brace). Scan brace-by-brace from the first `{` and
 * stop once balanced, ignoring anything after — rather than handing the
 * whole captured block to JSON.parse and failing on trailing garbage.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * The sentinel format emitted by some models resembles a JavaScript object
 * (`{path: "."}`) rather than strict JSON. Quote only bare object keys while
 * staying aware of strings and nested arrays/objects, then use JSON.parse so
 * values are never evaluated as code.
 */
function parseLooseObject(text: string): Record<string, unknown> | null {
  const objectText = extractFirstJsonObject(text);
  if (objectText === null) return null;
  try {
    const parsed: unknown = JSON.parse(quoteBareObjectKeys(objectText));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function quoteBareObjectKeys(text: string): string {
  const contexts: Array<{ type: "object" | "array"; expectsKey: boolean }> = [];
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === "{") {
      contexts.push({ type: "object", expectsKey: true });
      result += char;
      continue;
    }
    if (char === "[") {
      contexts.push({ type: "array", expectsKey: false });
      result += char;
      continue;
    }
    if (char === "}" || char === "]") {
      contexts.pop();
      result += char;
      continue;
    }

    const context = contexts.at(-1);
    if (char === "," && context?.type === "object") {
      context.expectsKey = true;
      result += char;
      continue;
    }
    if (char === ":" && context?.type === "object") {
      context.expectsKey = false;
      result += char;
      continue;
    }
    if (
      context?.type === "object" &&
      context.expectsKey &&
      /[A-Za-z_$]/.test(char)
    ) {
      let end = index + 1;
      while (end < text.length && /[\w$-]/.test(text[end]!)) end++;
      let colon = end;
      while (colon < text.length && /\s/.test(text[colon]!)) colon++;
      if (text[colon] === ":") {
        result += JSON.stringify(text.slice(index, end));
        index = end - 1;
        continue;
      }
    }
    result += char;
  }

  return result;
}

const FENCE_START = "```tool_call";
const TOOL_CALL_STARTS = [FENCE_START, SENTINEL_START];

/**
 * True once the buffer contains the fence start, or ends with a prefix of it
 * (the opening marker may itself be split across stream chunks).
 */
export function hasPendingFence(buffer: string): boolean {
  if (TOOL_CALL_STARTS.some((start) => buffer.includes(start))) return true;
  for (const start of TOOL_CALL_STARTS) {
    for (let len = Math.min(start.length, buffer.length); len > 0; len--) {
      if (buffer.endsWith(start.slice(0, len))) return true;
    }
  }
  return false;
}
