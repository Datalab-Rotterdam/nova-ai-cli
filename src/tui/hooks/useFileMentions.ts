import Fuse from "fuse.js";
import { useMemo } from "react";

export function useFileMentions(value: string, files: string[]): { query: string | null; matches: string[] } {
  const fuse = useMemo(() => new Fuse(files), [files]);

  const lastAt = value.lastIndexOf("@");
  if (lastAt === -1) return { query: null, matches: [] };

  const tail = value.slice(lastAt + 1);
  if (/\s/.test(tail)) return { query: null, matches: [] };

  if (!tail) return { query: "", matches: files.slice(0, 8) };
  return { query: tail, matches: fuse.search(tail).slice(0, 8).map((r) => r.item) };
}
