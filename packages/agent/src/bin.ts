#!/usr/bin/env node
import { readPackageVersion } from "./core/version.js";

const HELP = `nova-ai-agent — the Nova AI coding agent over the Agent Client Protocol.

Usage:
  nova-ai-agent [--acp]             Speak ACP over stdin/stdout (for editors and other clients)
  nova-ai-agent login [--no-browser] Connect your Nova AI account
  nova-ai-agent logout              Remove the stored API key
  nova-ai-agent --version | --help

For the interactive terminal UI install @datalabrotterdam/nova-ai-cli (\`nova-ai\`).`;

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (first === "--help" || first === "-h") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    process.stdout.write(`nova-ai-agent ${readPackageVersion() ?? "unknown"}\n`);
    return 0;
  }
  if (first === "login") {
    const { runLogin } = await import("./commands/login.js");
    return runLogin(rest);
  }
  if (first === "logout") {
    const { runLogout } = await import("./commands/login.js");
    return runLogout();
  }
  if (first === undefined || (first === "--acp" && rest.length === 0)) {
    const { default: runAcp } = await import("./acp/index.js");
    await runAcp();
    return 0;
  }
  process.stderr.write(`Unknown arguments: ${argv.join(" ")}\n\n${HELP}\n`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    // ACP ends the process itself; the other commands report a code.
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
