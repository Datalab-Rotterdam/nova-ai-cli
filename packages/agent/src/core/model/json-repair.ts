// Ported from nova-ai-vscode src/model/jsonRepair.ts (kept in sync by hand).
/**
 * Parses tool-call arguments produced by a model. Accepts empty input, double-encoded
 * JSON and common model mistakes (code fences, trailing commas, truncated closers).
 * Returns undefined when the arguments are not a JSON object even after repair.
 */
export function parseToolArguments(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }

  for (const candidate of [trimmed, repairJson(trimmed)]) {
    const parsed = tryParse(candidate);
    const value = typeof parsed === "string" ? tryParse(parsed) : parsed;
    if (isPlainObject(value)) {
      return value;
    }
  }

  return undefined;
}

export function isCompleteJson(text: string): boolean {
  return tryParse(text.trim()) !== undefined;
}

export function repairJson(text: string): string {
  let result = stripCodeFence(text.trim());
  result = closeOpenStructures(result);
  return result.replace(/,\s*([}\]])/g, "$1");
}

function stripCodeFence(text: string): string {
  const match = /^```[a-zA-Z]*\s*([\s\S]*?)\s*(```)?$/.exec(text);
  return match ? match[1] : text;
}

/** Appends missing closing quotes, brackets and braces for truncated JSON. */
function closeOpenStructures(text: string): string {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      closers.push("}");
    } else if (char === "[") {
      closers.push("]");
    } else if ((char === "}" || char === "]") && closers[closers.length - 1] === char) {
      closers.pop();
    }
  }

  return `${text}${inString ? '"' : ""}${closers.reverse().join("")}`;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
