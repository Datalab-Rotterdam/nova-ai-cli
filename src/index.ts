#!/usr/bin/env node
import { runBrowserAuth } from "./acp/auth-server.js";
import chat from "./tui/index.js";
import web from "./webui/index.js";
import acp from "./acp/index.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--setup")) {
    await runBrowserAuth();
    return;
  }

  if (args.includes("--acp")) {
    await acp(...args.slice(1));
    return;
  }

  if (args.includes("--web")) {
    await web(...args.slice(1));
    return;
  }

  await chat(...args.slice(1));
}


main().catch((err) => {
  console.error(err);
  process.exit(1)
});
