import type { ToolDefinition } from "./types.js";

const MAX_HINT_FILE_BYTES = 2_000_000;
const MAX_HINT_SNIPPET_LINES = 30;

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "replace one exact occurrence of old_string with new_string in a text file. Whitespace-only differences (line endings, indentation) are tolerated when the match is unambiguous; set replace_all to change every occurrence.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "absolute path" },
      old_string: { type: "string", description: "exact text to replace" },
      new_string: { type: "string", description: "replacement text" },
      replace_all: {
        type: "boolean",
        default: false,
        description: "replace every exact occurrence instead of requiring a unique match",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  requiredCapability: (caps) => !!caps?.fs?.readTextFile && !!caps?.fs?.writeTextFile,
  mutating: true,
  kind: "edit",
  async execute({ host, signal }, args) {
    const path = typeof args.path === "string" ? args.path : "";
    const oldString = typeof args.old_string === "string" ? args.old_string : "";
    const newString = typeof args.new_string === "string" ? args.new_string : "";
    const replaceAll = args.replace_all === true;
    if (!path) return { error: "edit_file requires a 'path' argument." };
    if (!oldString) return { error: "edit_file requires a non-empty 'old_string' argument." };

    let content: string;
    try {
      content = await host.readTextFile(path, signal);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to read file." };
    }

    const replacement = resolveReplacement(content, oldString, newString, replaceAll, path);
    if ("error" in replacement) return replacement;

    try {
      await host.writeTextFile(path, replacement.newContent, signal);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to write file." };
    }

    return {
      output: `Edited ${path}.`,
      diff: { path, oldText: content, newText: replacement.newContent },
    };
  },
};

type Replacement = { newContent: string } | { error: string };

function resolveReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  path: string,
): Replacement {
  // 1. Exact substring match. Replacement always goes through split/join —
  // String.replace(string, string) would expand $-patterns in new_string.
  const exactOccurrences = countOccurrences(content, oldString);
  if (exactOccurrences === 1 || (exactOccurrences > 1 && replaceAll)) {
    return { newContent: content.split(oldString).join(newString) };
  }
  if (exactOccurrences > 1) {
    const lineNumbers = exactMatchLineNumbers(content, oldString);
    return {
      error:
        `old_string matches ${exactOccurrences} locations in ${path} (lines ${lineNumbers.join(", ")}); ` +
        "add surrounding context to make it unique, or pass replace_all: true to change every occurrence.",
    };
  }

  const fileLines = splitLines(content);
  const oldLines = oldString.split(/\r?\n/);
  const crlf = content.includes("\r\n");
  const adaptNewString = (text: string) =>
    crlf && !text.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;

  // 2. Line-ending-normalized whole-line window match.
  const normalized = findWindows(fileLines, oldLines, (fileLine, oldLine) => fileLine === oldLine);
  if (normalized.length === 1) {
    return {
      newContent: spliceWindow(content, fileLines, normalized[0], oldLines.length, adaptNewString(newString)),
    };
  }

  // 3. Indentation-tolerant window match; re-indent new_string by the
  // first matched line's indentation delta.
  const trimmed = findWindows(
    fileLines,
    oldLines,
    (fileLine, oldLine) => fileLine.trim() === oldLine.trim(),
  ).filter((start) => oldLines.some((line) => line.trim() !== ""));
  if (trimmed.length === 1) {
    const start = trimmed[0];
    const reindented = reindent(newString, indentOf(oldLines[0]), indentOf(fileLines[start].text));
    return {
      newContent: spliceWindow(content, fileLines, start, oldLines.length, adaptNewString(reindented)),
    };
  }
  const ambiguous = normalized.length > 1 ? normalized : trimmed;
  if (ambiguous.length > 1) {
    return {
      error:
        `old_string matches ${ambiguous.length} locations in ${path} (lines ${ambiguous.map((start) => start + 1).join(", ")}); ` +
        "add surrounding context to make it unique.",
    };
  }

  // 4. No edit possible — return the closest window so the model can
  // correct old_string without re-reading the file. Hint only, never edits.
  const hint = content.length <= MAX_HINT_FILE_BYTES ? closestWindowHint(fileLines, oldLines) : null;
  if (!hint) return { error: `old_string not found in ${path}.` };
  return {
    error:
      `old_string not found in ${path}. Closest match (lines ${hint.startLine}-${hint.endLine}, ` +
      `${hint.differingLines} of ${oldLines.length} lines differ):\n${hint.snippet}\n` +
      "Adjust old_string to match the file exactly (the snippet above is the file's actual text) and retry.",
  };
}

type LineInfo = { text: string; start: number; end: number };

function splitLines(content: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let start = 0;
  while (true) {
    const newline = content.indexOf("\n", start);
    const rawEnd = newline === -1 ? content.length : newline;
    const end = rawEnd > start && content[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    lines.push({ text: content.slice(start, end), start, end });
    if (newline === -1) return lines;
    start = newline + 1;
  }
}

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function exactMatchLineNumbers(content: string, needle: string): number[] {
  const numbers: number[] = [];
  let index = content.indexOf(needle);
  while (index !== -1) {
    numbers.push(content.slice(0, index).split("\n").length);
    index = content.indexOf(needle, index + needle.length);
  }
  return numbers;
}

function findWindows(
  fileLines: LineInfo[],
  oldLines: string[],
  lineMatches: (fileLine: string, oldLine: string) => boolean,
): number[] {
  const starts: number[] = [];
  for (let start = 0; start + oldLines.length <= fileLines.length; start++) {
    let matched = true;
    for (let offset = 0; offset < oldLines.length; offset++) {
      if (!lineMatches(fileLines[start + offset].text, oldLines[offset])) {
        matched = false;
        break;
      }
    }
    if (matched) starts.push(start);
  }
  return starts;
}

function spliceWindow(
  content: string,
  fileLines: LineInfo[],
  start: number,
  lineCount: number,
  replacement: string,
): string {
  const from = fileLines[start].start;
  const to = fileLines[start + lineCount - 1].end;
  return content.slice(0, from) + replacement + content.slice(to);
}

function indentOf(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? "";
}

function reindent(text: string, oldIndent: string, fileIndent: string): string {
  if (oldIndent === fileIndent) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      if (fileIndent.endsWith(oldIndent)) {
        const prefix = fileIndent.slice(0, fileIndent.length - oldIndent.length);
        return prefix + line;
      }
      if (oldIndent.endsWith(fileIndent)) {
        const strip = oldIndent.slice(0, oldIndent.length - fileIndent.length);
        return line.startsWith(strip) ? line.slice(strip.length) : line;
      }
      return line;
    })
    .join("\n");
}

type WindowHint = {
  startLine: number;
  endLine: number;
  differingLines: number;
  snippet: string;
};

function closestWindowHint(fileLines: LineInfo[], oldLines: string[]): WindowHint | null {
  if (oldLines.length > fileLines.length) return null;
  if (oldLines.every((line) => line.trim() === "")) return null;

  let bestStart = -1;
  let bestScore = 0;
  for (let start = 0; start + oldLines.length <= fileLines.length; start++) {
    let score = 0;
    for (let offset = 0; offset < oldLines.length; offset++) {
      const fileLine = fileLines[start + offset].text;
      const oldLine = oldLines[offset];
      if (fileLine.trim() === oldLine.trim()) score += 1;
      else if (oldLine.trim() && fileLine.includes(oldLine.trim())) score += 0.5;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  if (bestStart === -1 || bestScore === 0) return null;

  const windowLines = fileLines.slice(bestStart, bestStart + oldLines.length);
  const differing = windowLines.filter(
    (line, offset) => line.text.trim() !== oldLines[offset].trim(),
  ).length;
  const snippetLines = windowLines.slice(0, MAX_HINT_SNIPPET_LINES).map((line) => line.text);
  const truncated = windowLines.length > MAX_HINT_SNIPPET_LINES ? "\n[snippet truncated]" : "";
  return {
    startLine: bestStart + 1,
    endLine: bestStart + oldLines.length,
    differingLines: differing,
    snippet: snippetLines.join("\n") + truncated,
  };
}
