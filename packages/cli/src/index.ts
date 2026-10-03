#!/usr/bin/env node
import { MAIN_HELP, parseCli, parseTuiArgs, versionText } from "./cli.js";

async function main(): Promise<number> {
  const command = parseCli(process.argv.slice(2));
  switch (command.mode) {
    case "error":
      process.stderr.write(`${command.message}\n\n${MAIN_HELP}\n`);
      return 2;
    case "help":
      process.stdout.write(`${MAIN_HELP}\n`);
      return 0;
    case "version":
      process.stdout.write(`${versionText()}\n`);
      return 0;
    case "acp": {
      if (command.args.length) {
        process.stderr.write(`--acp takes no other arguments (got ${command.args.join(" ")}).\n`);
        return 2;
      }
      const { default: runAcp } = await import("@datalabrotterdam/nova-ai-agent/acp/index.js");
      await runAcp();
      return 0;
    }
    case "print": {
      const { default: runHeadless } = await import("./headless/index.js");
      return runHeadless(command.args);
    }
    case "login": {
      const { runLogin } = await import("@datalabrotterdam/nova-ai-agent/commands/login.js");
      return runLogin(command.args);
    }
    case "logout": {
      const { runLogout } = await import("@datalabrotterdam/nova-ai-agent/commands/login.js");
      return runLogout();
    }
    case "web": {
      const { default: runWebUi } = await import("./webui/index.js");
      await runWebUi();
      return 0;
    }
    case "tui": {
      let options;
      try {
        options = parseTuiArgs(command.args);
      } catch (error) {
        process.stderr.write(`${(error as Error).message}\n\n${MAIN_HELP}\n`);
        return 2;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write(
          "nova-ai needs an interactive terminal. For scripts and pipes use `nova-ai -p \"<prompt>\"`, for editors `nova-ai --acp`.\n",
        );
        return 2;
      }
      const { default: runChat } = await import("./tui/index.js");
      return runChat(options);
    }
  }
}

main().then(
  (code) => {
    // --acp and the TUI end the process themselves; others report a code.
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
