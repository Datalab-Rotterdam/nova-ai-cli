import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type AutocompleteItem = {
  /** Text that replaces the prefix. */
  value: string;
  label: string;
  description?: string;
};

export type AutocompleteSuggestions = {
  items: AutocompleteItem[];
  /** The text before the cursor that a completion replaces. */
  prefix: string;
};

export type CommandItem = { name: string; description?: string };

export type CompletionResult = {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
};

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
const MAX_SUGGESTIONS = 20;

/**
 * Suggestions for the prompt editor: `/command` names at the start of the
 * prompt, `@file` mentions (via fd when installed, otherwise a pre-scanned
 * file list) and, on Tab (`force`), plain path completion.
 */
export class WorkspaceAutocompleteProvider {
  readonly triggerCharacters = ["@", "/"];

  constructor(
    private readonly commands: CommandItem[],
    private readonly cwd: string,
    private readonly files: string[],
    private readonly fdPath: string | null = null,
  ) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);

    const mention = extractMentionPrefix(before);
    if (mention) return this.mentionSuggestions(mention, options.signal);

    if (cursorLine === 0 && before.startsWith("/") && !/\s/.test(before)) {
      const items = filterCommands(this.commands, before.slice(1));
      return items.length ? { items, prefix: before } : null;
    }

    if (!options.force) return null;
    const pathPrefix = extractPathPrefix(before);
    if (pathPrefix === null) return null;
    const items = this.pathSuggestions(pathPrefix);
    return items.length ? { items, prefix: pathPrefix } : null;
  }

  shouldTriggerFileCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol).trim();
    return !(before.startsWith("/") && !before.includes(" "));
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): CompletionResult {
    const line = lines[cursorLine] ?? "";
    const beforePrefix = line.slice(0, cursorCol - prefix.length);
    let after = line.slice(cursorCol);
    // Completing inside `@"…"` must not leave the old closing quote behind.
    if (prefix.includes('"') && item.value.endsWith('"') && after.startsWith('"'))
      after = after.slice(1);

    const isCommand =
      cursorLine === 0 && prefix.startsWith("/") && beforePrefix.trim() === "";
    const isDirectory = item.value.replace(/"$/, "").endsWith("/");
    let inserted: string;
    let cursorOffset: number;
    if (isCommand) {
      inserted = `/${item.value} `;
      cursorOffset = inserted.length;
    } else {
      // Directories stay open so the user can keep completing inside them.
      const suffix = isDirectory || !prefix.startsWith("@") ? "" : " ";
      inserted = `${item.value}${suffix}`;
      cursorOffset =
        isDirectory && item.value.endsWith('"')
          ? item.value.length - 1
          : inserted.length;
    }
    const next = [...lines];
    next[cursorLine] = `${beforePrefix}${inserted}${after}`;
    return {
      lines: next,
      cursorLine,
      cursorCol: beforePrefix.length + cursorOffset,
    };
  }

  private async mentionSuggestions(
    prefix: string,
    signal: AbortSignal,
  ): Promise<AutocompleteSuggestions | null> {
    if (signal.aborted) return null;
    const quoted = prefix.startsWith('@"');
    const query = prefix
      .slice(quoted ? 2 : 1)
      .replace(/"$/, "")
      .replace(/\\/g, "/");

    // fd respects .gitignore and isn't bounded by a pre-scanned file list;
    // the in-memory scorer is the fallback when fd is missing or finds nothing.
    if (this.fdPath) {
      const entries = await walkWithFd(this.cwd, this.fdPath, query, signal);
      if (signal.aborted) return null;
      const items = entries
        .map((entry) => ({
          ...entry,
          score: query ? scorePath(entry.path, query.toLowerCase()) : 1,
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, MAX_SUGGESTIONS)
        .map((entry) => mentionItem(entry.path, entry.isDirectory, quoted));
      if (items.length) return { items, prefix };
    }

    const lowered = query.toLowerCase();
    const items = this.files
      .map((path) => ({ path, score: scorePath(path, lowered) }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.path.localeCompare(right.path),
      )
      .slice(0, MAX_SUGGESTIONS)
      .map(({ path }) => mentionItem(path, false, quoted));
    return items.length ? { items, prefix } : null;
  }

  private pathSuggestions(prefix: string): AutocompleteItem[] {
    const quoted = prefix.startsWith('"');
    const raw = quoted ? prefix.slice(1) : prefix;
    const expanded = raw === "~" || raw.startsWith("~/")
      ? join(homedir(), raw.slice(1))
      : raw;
    const absolute =
      expanded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(expanded);
    const separator = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
    const listsDirectory = raw === "" || raw === "~" || separator === raw.length - 1;
    const directoryPart = listsDirectory ? expanded : dirname(expanded);
    const namePrefix = listsDirectory ? "" : basename(expanded);
    const displayDirectory =
      raw === "~" ? "~/" : separator >= 0 ? raw.slice(0, separator + 1) : "";
    const searchDirectory = absolute
      ? directoryPart
      : join(this.cwd, directoryPart);

    let entries;
    try {
      entries = readdirSync(searchDirectory, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) =>
        entry.name.toLowerCase().startsWith(namePrefix.toLowerCase()),
      )
      .map((entry) => {
        let isDirectory = entry.isDirectory();
        if (!isDirectory && entry.isSymbolicLink()) {
          try {
            isDirectory = statSync(
              join(searchDirectory, entry.name),
            ).isDirectory();
          } catch {
            // Broken link: complete it as a file.
          }
        }
        const path = `${displayDirectory}${entry.name}${isDirectory ? "/" : ""}`;
        return {
          value: quoted || path.includes(" ") ? `"${path}"` : path,
          label: `${entry.name}${isDirectory ? "/" : ""}`,
          isDirectory,
        };
      })
      .sort(
        (left, right) =>
          Number(right.isDirectory) - Number(left.isDirectory) ||
          left.label.localeCompare(right.label),
      )
      .slice(0, 50)
      .map(({ value, label }) => ({ value, label }));
  }
}

function mentionItem(
  path: string,
  isDirectory: boolean,
  quoted: boolean,
): AutocompleteItem {
  const plain = path.replace(/\/$/, "");
  const completion = isDirectory ? `${plain}/` : plain;
  return {
    value:
      quoted || completion.includes(" ")
        ? `@"${completion}"`
        : `@${completion}`,
    label: `${basename(plain)}${isDirectory ? "/" : ""}`,
    description: plain,
  };
}

/** `/name` completion: prefix matches first, then substring, then subsequence. */
export function filterCommands(
  commands: CommandItem[],
  query: string,
): AutocompleteItem[] {
  const lowered = query.toLowerCase();
  const rank = (name: string): number => {
    const value = name.toLowerCase();
    if (!lowered) return 1;
    if (value.startsWith(lowered)) return 3;
    if (value.includes(lowered)) return 2;
    let cursor = 0;
    for (const char of lowered) {
      cursor = value.indexOf(char, cursor);
      if (cursor === -1) return 0;
      cursor++;
    }
    return 1;
  };
  return commands
    .map((command) => ({ command, score: rank(command.name) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ command }) => ({
      value: command.name,
      label: command.name,
      ...(command.description ? { description: command.description } : {}),
    }));
}

export function extractMentionPrefix(text: string): string | null {
  return /(?:^|\s)(@(?:"[^"]*|[^\s]*))$/.exec(text)?.[1] ?? null;
}

function extractPathPrefix(text: string): string | null {
  let quoteStart = -1;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '"') quoteStart = quoteStart === -1 ? index : -1;
  }
  if (quoteStart >= 0) return text.slice(quoteStart);
  for (let index = text.length - 1; index >= 0; index--) {
    if (PATH_DELIMITERS.has(text[index]!)) return text.slice(index + 1);
  }
  return text;
}

function scorePath(path: string, query: string): number {
  if (!query) return 1;
  const normalized = path.toLowerCase().replace(/\/$/, "");
  const name = basename(normalized);
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 60;
  if (normalized.includes(query)) return 40;

  let cursor = 0;
  for (const char of query) {
    cursor = normalized.indexOf(char, cursor);
    if (cursor === -1) return 0;
    cursor++;
  }
  return 20;
}

type FdEntry = { path: string; isDirectory: boolean };

function fdQuery(query: string): string {
  if (!query.includes("/")) return query;
  const trailing = query.endsWith("/");
  const segments = query
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (segments.length === 0) return query;
  return `${segments.join("[\\\\/]")}${trailing ? "[\\\\/]" : ""}`;
}

/** Lists files and directories with fd (respects .gitignore, skips .git). */
function walkWithFd(
  cwd: string,
  fdPath: string,
  query: string,
  signal: AbortSignal,
): Promise<FdEntry[]> {
  const args = [
    "--base-directory",
    cwd,
    "--max-results",
    "100",
    "--type",
    "f",
    "--type",
    "d",
    "--follow",
    "--hidden",
    "--exclude",
    ".git",
  ];
  if (query.includes("/")) args.push("--full-path");
  if (query) args.push(fdQuery(query));

  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve([]);
      return;
    }
    const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const finish = (entries: FdEntry[]) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(entries);
    };
    const onAbort = () => {
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => finish([]));
    child.on("close", (code) => {
      if (signal.aborted || code !== 0) {
        finish([]);
        return;
      }
      finish(
        stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => line.replace(/\\/g, "/"))
          .filter((line) => !/(^|\/)\.git(\/|$)/.test(line))
          .map((line) => ({ path: line, isDirectory: line.endsWith("/") })),
      );
    });
  });
}
