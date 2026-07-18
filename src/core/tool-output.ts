export const MAX_TOOL_OUTPUT_CHARS = 100_000;

export function truncateToolOutput(text: string, label = "Tool"): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const notice = `\n\n[${label} output truncated from ${text.length} to ${MAX_TOOL_OUTPUT_CHARS} characters. Narrow the next tool request to the relevant files or range.]\n\n`;
  const retainedChars = MAX_TOOL_OUTPUT_CHARS - notice.length;
  const headChars = Math.ceil(retainedChars * 0.6);
  const tailChars = retainedChars - headChars;
  return `${text.slice(0, headChars)}${notice}${text.slice(-tailChars)}`;
}

export function truncateStoredToolMessage(message: string): string {
  // Combined multi-call results are bounded as a whole; per-call sections
  // were already individually truncated when the batch ran.
  if (message.startsWith("Tool results (")) return truncateToolOutput(message);
  const prefix = ["Tool result: ", "Tool error: "].find((candidate) =>
    message.startsWith(candidate),
  );
  if (!prefix) return message;
  return `${prefix}${truncateToolOutput(message.slice(prefix.length))}`;
}
