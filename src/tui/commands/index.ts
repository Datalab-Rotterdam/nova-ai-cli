import { builtinCommands } from "./builtins.js";
import type { SlashCommand } from "./types.js";

export type { SlashCommand, SlashCommandContext } from "./types.js";

const COMMANDS: SlashCommand[] = [...builtinCommands];

export function allCommands(): SlashCommand[] {
  return COMMANDS;
}

export function findCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find((c) => c.name === name);
}
