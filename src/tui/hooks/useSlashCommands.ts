import Fuse from "fuse.js";
import { useMemo } from "react";
import { allCommands, type SlashCommand } from "../commands/index.js";

export function useSlashCommands(input: string): SlashCommand[] {
  const fuse = useMemo(() => new Fuse(allCommands(), { keys: ["name", "description"] }), []);

  if (!input.startsWith("/")) return [];
  const query = input.slice(1);
  if (!query) return allCommands();
  return fuse.search(query).map((r) => r.item);
}
