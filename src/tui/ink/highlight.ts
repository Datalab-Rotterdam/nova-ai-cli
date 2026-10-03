import { highlight, supportsLanguage } from "cli-highlight";

const LANGUAGE_ALIASES: Record<string, string> = {
  mts: "typescript",
  cts: "typescript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "bash",
  zsh: "bash",
  yml: "yaml",
};

export function languageFromPath(
  path: string | null | undefined,
): string | undefined {
  const ext = path?.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  return ext ? supportedLanguage(ext) : undefined;
}

export function supportedLanguage(
  name: string | null | undefined,
): string | undefined {
  if (!name) return undefined;
  const candidate = LANGUAGE_ALIASES[name.toLowerCase()] ?? name.toLowerCase();
  return supportsLanguage(candidate) ? candidate : undefined;
}

/** Highlighted lines; plain lines when the language is unknown or fails. */
export function highlightLines(
  text: string,
  language: string | undefined,
): string[] {
  if (!text) return [];
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!language) return trimmed.split("\n");
  try {
    return highlight(trimmed, { language, ignoreIllegals: true }).split("\n");
  } catch {
    return trimmed.split("\n");
  }
}
