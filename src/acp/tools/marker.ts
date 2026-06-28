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

/**
 * Looks for one complete ```tool_call fenced block in the accumulated stream
 * buffer. Returns null while the block hasn't fully arrived yet (it may be
 * split across multiple stream chunks).
 */
export function extractToolCall(buffer: string): ParsedToolCall | null {
  const match = FENCE_RE.exec(buffer);
  if (!match) return null;

  const jsonText = extractFirstJsonObject(match[1]);
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
  return FENCE_RE.test(buffer) && extractToolCall(buffer) === null;
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

const FENCE_START = "```tool_call";

/**
 * True once the buffer contains the fence start, or ends with a prefix of it
 * (the opening marker may itself be split across stream chunks).
 */
export function hasPendingFence(buffer: string): boolean {
  if (buffer.includes(FENCE_START)) return true;
  for (let len = Math.min(FENCE_START.length, buffer.length); len > 0; len--) {
    if (buffer.endsWith(FENCE_START.slice(0, len))) return true;
  }
  return false;
}
