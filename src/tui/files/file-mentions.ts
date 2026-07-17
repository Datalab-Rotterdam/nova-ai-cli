import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type WorkspaceFileMention = {
  absolutePath: string;
  relativePath: string;
};

const MENTION_RE = /@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
const TRAILING_PUNCTUATION = /[.,;:!?\)\]\}]+$/;

export function findWorkspaceFileMentions(text: string, cwd: string): WorkspaceFileMention[] {
  const workspaceRoot = resolve(cwd);
  const mentions = new Map<string, WorkspaceFileMention>();

  for (const match of text.matchAll(MENTION_RE)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    const candidates = [raw, raw.replace(TRAILING_PUNCTUATION, "")].filter((value, index, all) => value && all.indexOf(value) === index);
    for (const candidate of candidates) {
      const normalized = candidate.replace(/[\\/]/g, sep);
      const absolutePath = resolve(workspaceRoot, normalized);
      const relativePath = relative(workspaceRoot, absolutePath);
      if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) continue;
      try {
        if (!statSync(absolutePath).isFile()) continue;
      } catch {
        continue;
      }
      mentions.set(absolutePath.toLowerCase(), {
        absolutePath,
        relativePath: relativePath.split(sep).join("/"),
      });
      break;
    }
  }

  return [...mentions.values()];
}
