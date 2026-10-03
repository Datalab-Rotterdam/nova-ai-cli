import { diffLines } from "diff";
import type { ContextUsage } from "../../core/context-usage.js";
import type { ToolCallView } from "../state/types.js";
import { highlightLines, languageFromPath } from "./highlight.js";

export type ChangedLine = { kind: "added" | "removed"; text: string };

export function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, "")}m`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(value);
}

export function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

export function toolCallSummary(call: ToolCallView): string {
  const candidates = [
    call.args.path,
    call.args.command,
    call.args.script,
    call.args.query,
    call.args.url,
  ];
  return (
    candidates.find((value): value is string => typeof value === "string") ?? ""
  );
}

/** Read-only and search tools collapse to a one-line summary. */
export function isCompactTool(call: ToolCallView): boolean {
  return !call.mutating || call.kind === "read" || call.kind === "search";
}

/** Tools that merge with their neighbours into one "Read 3 files" line. */
export function isActivityTool(call: ToolCallView): boolean {
  return (
    isCompactTool(call) ||
    call.name === "run_command" ||
    call.name === "run_package_script"
  );
}

export function activityStatus(
  calls: ToolCallView[],
): ToolCallView["status"] {
  return calls.some((call) => call.status === "failed")
    ? "failed"
    : calls.some((call) => call.status === "pending")
      ? "pending"
      : "completed";
}

export function activitySummary(
  calls: ToolCallView[],
  pending: boolean,
): string {
  const counts = { files: 0, directories: 0, searches: 0, shells: 0, other: 0 };
  for (const call of calls) {
    if (call.name === "read_file") counts.files++;
    else if (call.name === "list_directory") counts.directories++;
    else if (call.name === "search_text") counts.searches++;
    else if (call.name === "run_command" || call.name === "run_package_script")
      counts.shells++;
    else counts.other++;
  }

  const phrases = [
    activityPhrase(counts.files, pending ? "reading" : "read", "file"),
    activityPhrase(
      counts.directories,
      pending ? "listing" : "listed",
      "directory",
    ),
    activityPhrase(counts.searches, pending ? "searching" : "searched", "path"),
    activityPhrase(counts.shells, pending ? "running" : "ran", "shell command"),
    activityPhrase(counts.other, pending ? "using" : "used", "tool"),
  ].filter((phrase): phrase is string => !!phrase);

  if (phrases.length === 0) return pending ? "Working" : "Finished";
  return phrases
    .map((phrase, index) =>
      index === 0 ? phrase[0]!.toUpperCase() + phrase.slice(1) : phrase,
    )
    .join(", ");
}

function activityPhrase(
  count: number,
  verb: string,
  noun: string,
): string | null {
  if (count === 0) return null;
  const plural = noun === "directory" ? "directories" : `${noun}s`;
  return `${verb} ${count} ${count === 1 ? noun : plural}`;
}

/** The last few lines that describe what a group of tools did. */
export function activityDetails(calls: ToolCallView[], limit = 3): string[] {
  return calls
    .flatMap(callActivityDetails)
    .map(sanitizeTerminalText)
    .filter(Boolean)
    .slice(-limit);
}

function callActivityDetails(call: ToolCallView): string[] {
  if (call.status === "failed") {
    const output = outputLines(call.output).slice(-3);
    if (output.length === 0) return ["Error: Tool failed."];
    return output.map((line, index) => (index === 0 ? `Error: ${line}` : line));
  }

  if (call.name === "run_command" || call.name === "run_package_script") {
    const output = outputLines(call.output);
    if (output.length > 0) return output;
    const command =
      typeof call.args.command === "string"
        ? call.args.command
        : typeof call.args.script === "string"
          ? `npm run ${call.args.script}`
          : call.name;
    return [`$ ${command}`];
  }

  const path = typeof call.args.path === "string" ? call.args.path : null;
  return [path ?? call.name];
}

export function outputLines(output: string | null | undefined): string[] {
  return (output ?? "")
    .split(/\r?\n|\r/)
    .map((line) => sanitizeTerminalText(line.trimEnd()))
    .filter(Boolean);
}

/** Strips escape sequences and control characters from tool output. */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** Added and removed lines, syntax highlighted by the file's language. */
export function changedLines(
  oldText: string,
  newText: string,
  path?: string | null,
): ChangedLine[] {
  const language = languageFromPath(path);
  const oldHighlighted = highlightLines(oldText, language);
  const newHighlighted = highlightLines(newText, language);
  let oldIndex = 0;
  let newIndex = 0;
  const result: ChangedLine[] = [];
  for (const change of diffLines(oldText, newText)) {
    const value = change.value.endsWith("\n")
      ? change.value.slice(0, -1)
      : change.value;
    const plainLines = value.split("\n");
    if (change.added) {
      plainLines.forEach((plain, index) => {
        const text = newHighlighted[newIndex + index] ?? plain;
        result.push({ kind: "added", text: text.replace(/\r$/, "") });
      });
      newIndex += plainLines.length;
    } else if (change.removed) {
      plainLines.forEach((plain, index) => {
        const text = oldHighlighted[oldIndex + index] ?? plain;
        result.push({ kind: "removed", text: text.replace(/\r$/, "") });
      });
      oldIndex += plainLines.length;
    } else {
      oldIndex += plainLines.length;
      newIndex += plainLines.length;
    }
  }
  return result;
}

export function formatToolCallDetails(call: ToolCallView): string {
  const rows = [
    `${call.name} [${call.status}]`,
    `kind: ${call.kind}`,
    `mutating: ${call.mutating ? "yes" : "no"}`,
    "",
    "Arguments:",
    JSON.stringify(call.args, null, 2),
  ];
  if (call.diff) {
    rows.push("", `Diff: ${call.diff.path}`);
    for (const line of changedLines(
      call.diff.oldText ?? "",
      call.diff.newText,
      call.diff.path,
    )) {
      rows.push(`${line.kind === "added" ? "+" : "-"} ${line.text}`);
    }
  }
  if (call.output) rows.push("", "Output:", call.output);
  return rows.join("\n");
}

export function formatContextUsage(usage: ContextUsage): string {
  const rows: Array<[string, number]> = [
    ["System", usage.categories.system],
    ["Conversation", usage.categories.conversation],
    ["Agents", usage.categories.agents],
    ["Thinking", usage.categories.thinking],
    ["Tools", usage.categories.tools],
    ["Skills", usage.categories.skills],
    ["Memory", usage.categories.memory],
  ];
  const lines = rows.map(([label, tokens]) => {
    const share = usage.totalTokens
      ? `${((tokens / usage.totalTokens) * 100).toFixed(1)}%`
      : "0.0%";
    return `${label.padEnd(14)} ${tokens.toLocaleString("en-US").padStart(10)}  ${share.padStart(6)}`;
  });
  const total = usage.contextWindow
    ? `${usage.totalTokens.toLocaleString("en-US")} / ${usage.contextWindow.toLocaleString("en-US")} (${usage.percentUsed?.toFixed(1) ?? "0.0"}%)`
    : usage.totalTokens.toLocaleString("en-US");
  const remaining =
    usage.remainingTokens === null
      ? null
      : `Remaining      ${usage.remainingTokens.toLocaleString("en-US").padStart(10)}`;

  return [
    "Estimated tokens in the next model request",
    "",
    ...lines,
    "",
    `Total          ${total}`,
    ...(remaining ? [remaining] : []),
    "",
    `Footer: ctx:${formatTokenCount(usage.totalTokens)}${usage.contextWindow ? `/${formatTokenCount(usage.contextWindow)}` : ""}`,
    "Counts are estimates because Nova models can use different tokenizers.",
  ].join("\n");
}
