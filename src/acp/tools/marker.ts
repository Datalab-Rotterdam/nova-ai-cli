export type ParsedToolCall = {
  name: string;
  args: Record<string, unknown>;
  matchStart: number;
  matchEnd: number;
};

// Greedy match: takes the LAST closing ``` in the buffer, not the first. The
// JSON payload (e.g. write_file content) may itself contain literal ``` runs
// (markdown snippets, code fences) — a lazy match would close on those and
// truncate/corrupt the JSON.
const FENCE_RE = /```tool_call\s*\n([\s\S]*)\n```/;
const SENTINEL_START = "<|tool_call>";
const SENTINEL_RE = /<\|tool_call>([\s\S]*?)<tool_call\|>/;

/**
 * Looks for one complete ```tool_call fenced block in the accumulated stream
 * buffer. Returns null while the block hasn't fully arrived yet (it may be
 * split across multiple stream chunks).
 */
export function extractToolCall(buffer: string): ParsedToolCall | null {
  const match = FENCE_RE.exec(buffer);
  if (match) return extractFencedToolCall(match);

  const sentinel = SENTINEL_RE.exec(buffer);
  if (!sentinel) return null;
  return extractSentinelToolCall(sentinel);
}

function extractFencedToolCall(match: RegExpExecArray): ParsedToolCall | null {
  const payload = match[1];
  if (payload === undefined) return null;

  const jsonText = extractFirstJsonObject(payload);
  if (jsonText === null) return null;

  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed?.name !== "string") return null;
    return {
      name: parsed.name,
      args: unwrapArgs(typeof parsed.args === "object" && parsed.args !== null ? parsed.args : parsed),
      matchStart: match.index,
      matchEnd: match.index + match[0].length,
    };
  } catch {
    return null;
  }
}

function extractSentinelToolCall(match: RegExpExecArray): ParsedToolCall | null {
  const payload = match[1]?.trim();
  if (!payload) return null;

  const call = /^call:([^:\s]+):\s*([\s\S]+)$/.exec(payload);
  if (!call?.[1] || !call[2]) return null;
  const args = parseLooseObject(call[2]);
  if (!args) return null;

  return {
    name: call[1],
    args,
    matchStart: match.index,
    matchEnd: match.index + match[0].length,
  };
}

/**
 * Models occasionally double-wrap the payload, e.g. {"args": {"args": {...}}}.
 * Unwrap that one level so the tool still receives its real arguments
 * instead of an object whose only key is "args".
 */
function unwrapArgs(args: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(args);
  if (keys.length === 1 && keys[0] === "args" && typeof args.args === "object" && args.args !== null) {
    return args.args as Record<string, unknown>;
  }
  return args;
}

/**
 * True when a ```tool_call fence is fully present (closing ``` arrived) but
 * its JSON payload failed to parse — distinct from "no tool call at all" so
 * the caller can feed the model a correction instead of treating a botched
 * tool call as the model's final answer.
 */
export function hasMalformedToolCall(buffer: string): boolean {
  return (FENCE_RE.test(buffer) || SENTINEL_RE.test(buffer)) && extractToolCall(buffer) === null;
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
      ? parsed as Record<string, unknown>
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
    if (context?.type === "object" && context.expectsKey && /[A-Za-z_$]/.test(char)) {
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
