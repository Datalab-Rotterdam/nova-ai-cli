import { readPackageVersion } from "./core/version.js";

export type CliMode = "tui" | "print" | "acp" | "login" | "logout" | "version" | "help" | "web";

export type CliCommand =
  | { mode: CliMode; args: string[] }
  | { mode: "error"; message: string };

const SUBCOMMANDS: Record<string, CliMode> = {
  login: "login",
  logout: "logout",
  help: "help",
  version: "version",
};

/** Flags that select a mode; they only count as whole arguments, before "--". */
const MODE_FLAGS: Record<string, CliMode> = {
  "--acp": "acp",
  "-p": "print",
  "--print": "print",
  "--headless": "print",
  "--setup": "login",
  "--version": "version",
  "-v": "version",
  "--web": "web",
};

/**
 * Decides what to run. A prompt can never switch modes: mode flags must be
 * whole arguments before "--", and two different modes are a usage error.
 * --help is passed to the selected mode (e.g. `nova-ai -p --help`).
 */
export function parseCli(argv: string[]): CliCommand {
  const first = argv[0];
  if (first !== undefined && SUBCOMMANDS[first]) {
    return { mode: SUBCOMMANDS[first]!, args: argv.slice(1) };
  }
  const end = argv.indexOf("--");
  const options = end >= 0 ? argv.slice(0, end) : argv;
  const modes = new Set(options.flatMap((arg) => (MODE_FLAGS[arg] ? [MODE_FLAGS[arg]!] : [])));
  if (modes.size > 1) {
    return { mode: "error", message: `Choose one mode, not ${[...modes].join(" and ")}.` };
  }
  const mode = [...modes][0];
  const wantsHelp = options.includes("--help") || options.includes("-h");
  if (!mode) return wantsHelp ? { mode: "help", args: [] } : { mode: "tui", args: argv };
  // Mode flags the target does not parse itself are removed.
  const drop = new Set(["--acp", "--headless", "--setup", "--version", "-v", "--web"]);
  return { mode, args: argv.filter((arg, index) => !(drop.has(arg) && (end < 0 || index < end))) };
}

export function versionText(): string {
  return `nova-ai ${readPackageVersion() ?? "unknown"}`;
}

export const MAIN_HELP = `Nova AI — agentic coding in your terminal, and an ACP agent for editors.

Usage:
  nova-ai [options]                 Interactive terminal UI
  nova-ai -p [options] [prompt]     Run one request headless (see nova-ai -p --help)
  nova-ai --acp                     Agent Client Protocol over stdio (for editors)
  nova-ai login [--no-browser]      Connect your Nova AI account
  nova-ai logout                    Remove the stored API key

Interactive options:
      --resume <session-id>         Continue a saved session
  -c, --continue                    Continue the most recent session in this folder
      --model <id>                  Use this model

General:
  -h, --help                        Show help
  -v, --version                     Show the version

Environment:
  NOVA_API_KEY, NOVA_MODEL          Use this key / model instead of the stored ones
  NOVA_BASE_URL                     Use another Nova gateway
  NOVA_AI_HOME                      Settings folder (default ~/.nova-ai)
  NOVA_TOOL_PROTOCOL                Force "native" or "text" tool calling`;

export type TuiOptions = { resume: string | null; continueLast: boolean; model: string | null };

export function parseTuiArgs(args: string[]): TuiOptions {
  const options: TuiOptions = { resume: null, continueLast: false, model: null };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = (name: string) => {
      const next = args[++index];
      if (!next || next.startsWith("-")) throw new Error(`${name} requires a value.`);
      return next;
    };
    if (arg === "--resume") options.resume = value(arg);
    else if (arg.startsWith("--resume=")) options.resume = arg.slice("--resume=".length);
    else if (arg === "--continue" || arg === "-c") options.continueLast = true;
    else if (arg === "--model") options.model = value(arg);
    else if (arg.startsWith("--model=")) options.model = arg.slice("--model=".length);
    else throw new Error(`Unknown option for the interactive UI: ${arg}`);
  }
  if (options.resume && options.continueLast) {
    throw new Error("Use either --continue or --resume, not both.");
  }
  return options;
}
