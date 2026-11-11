import { builtinCommands } from "./builtins.js";
import type { SlashCommand, SlashCommandContext } from "./types.js";

export type { SlashCommand, SlashCommandContext } from "./types.js";

const COMMANDS: SlashCommand[] = [...builtinCommands];

/** The commands to offer; with a context, only those available right now. */
export function allCommands(ctx?: SlashCommandContext): SlashCommand[] {
  return ctx ? COMMANDS.filter((c) => c.available?.(ctx) ?? true) : COMMANDS;
}

export function findCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find((c) => c.name === name);
}
