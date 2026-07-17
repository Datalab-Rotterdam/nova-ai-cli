import { basename } from "node:path";
import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from "@earendil-works/pi-tui";

export class WorkspaceAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ["@", "#"];
  private readonly fallback: CombinedAutocompleteProvider;

  constructor(
    commands: Array<AutocompleteItem | SlashCommand>,
    cwd: string,
    private readonly files: string[],
  ) {
    this.fallback = new CombinedAutocompleteProvider(commands, cwd);
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const prefix = extractMentionPrefix((lines[cursorLine] ?? "").slice(0, cursorCol));
    if (!prefix) return this.fallback.getSuggestions(lines, cursorLine, cursorCol, options);
    if (options.signal.aborted) return null;

    const quoted = prefix.startsWith('@"');
    const query = prefix.slice(quoted ? 2 : 1).replace(/"$/, "").replace(/\\/g, "/").toLowerCase();
    const suggestions = this.files
      .map((path) => ({ path, score: scorePath(path, query) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, 20)
      .map(({ path }) => ({
        value: path.includes(" ") || quoted ? `@"${path}"` : `@${path}`,
        label: basename(path),
        description: path,
      }));
    return suggestions.length ? { items: suggestions, prefix } : null;
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.fallback.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.fallback.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}

function extractMentionPrefix(text: string): string | null {
  return /(?:^|\s)(@(?:"[^"]*|[^\s]*))$/.exec(text)?.[1] ?? null;
}

function scorePath(path: string, query: string): number {
  if (!query) return 1;
  const normalized = path.toLowerCase();
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
