import { readdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type WorkspaceFileMention = {
  absolutePath: string;
  relativePath: string;
  isDirectory: boolean;
};

const MENTION_RE = /@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
const TRAILING_PUNCTUATION = /[.,;:!?\)\]\}]+$/;
const MAX_MENTIONS = 10;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_CHARS = 50_000;
const MAX_DIRECTORY_ENTRIES = 200;

/** `@path` mentions of files and folders inside the workspace (at most 10). */
export function findWorkspaceFileMentions(text: string, cwd: string): WorkspaceFileMention[] {
  const workspaceRoot = resolve(cwd);
  const mentions = new Map<string, WorkspaceFileMention>();

  for (const match of text.matchAll(MENTION_RE)) {
    if (mentions.size >= MAX_MENTIONS) break;
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    const candidates = [raw, raw.replace(TRAILING_PUNCTUATION, "")].filter((value, index, all) => value && all.indexOf(value) === index);
    for (const candidate of candidates) {
      const normalized = candidate.replace(/[\\/]/g, sep);
      const absolutePath = resolve(workspaceRoot, normalized);
      const relativePath = relative(workspaceRoot, absolutePath);
      if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) continue;
      let isDirectory: boolean;
      try {
        const info = statSync(absolutePath);
        if (!info.isFile() && !info.isDirectory()) continue;
        isDirectory = info.isDirectory();
      } catch {
        continue;
      }
      mentions.set(absolutePath.toLowerCase(), {
        absolutePath,
        relativePath: relativePath.split(sep).join("/"),
        isDirectory,
      });
      break;
    }
  }

  return [...mentions.values()];
}

/**
 * What the model gets for one mention: a file's text (cut at 50k characters;
 * binary and >2 MiB files are only named) or a folder's direct entries.
 */
export async function describeMention(
  mention: WorkspaceFileMention,
  readText: (path: string) => Promise<string>,
): Promise<string> {
  // Same wording as the desktop app, so the model sees one format: `@path (absolute path)`.
  const at = `@${mention.relativePath} (${mention.absolutePath})`;
  try {
    if (mention.isDirectory) {
      const entries = readdirSync(mention.absolutePath, { withFileTypes: true })
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
        .sort();
      const shown = entries.slice(0, MAX_DIRECTORY_ENTRIES).join(", ");
      const more = entries.length > MAX_DIRECTORY_ENTRIES ? ` … and ${entries.length - MAX_DIRECTORY_ENTRIES} more` : "";
      return `The user points at the folder ${at}, which holds: ${shown || "(empty)"}${more}`;
    }
    if (statSync(mention.absolutePath).size > MAX_FILE_BYTES) {
      return `The user mentioned ${at}; it is over 2 MiB, so read the parts you need yourself.`;
    }
    const content = await readText(mention.absolutePath);
    if (content.includes("\u0000")) return `The user mentioned ${at}, a binary file (not included).`;
    const clipped = content.length > MAX_FILE_CHARS
      ? `${content.slice(0, MAX_FILE_CHARS)}\n… (cut off; read the rest yourself)`
      : content;
    return `The user attached ${at}:\n<file>\n${clipped}\n</file>`;
  } catch (error) {
    return `[could not read @${mention.relativePath}: ${error instanceof Error ? error.message : "unknown error"}]`;
  }
}
