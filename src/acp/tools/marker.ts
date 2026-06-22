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

  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed?.name !== "string") return null;
    return {
      name: parsed.name,
      args: typeof parsed.args === "object" && parsed.args !== null ? parsed.args : parsed,
      matchStart: match.index,
      matchEnd: match.index + match[0].length,
    };
  } catch {
    return null;
  }
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
