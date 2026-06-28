import { render } from "ink";
import React from "react";
import { readCredentials } from "../acp/credentials.js";
import { App } from "./app.js";

export async function runChat(...args: string[]): Promise<void> {
  const credentials = readCredentials();
  if (!credentials) {
    console.log("nova-ai-cli isn't connected to a Nova AI account yet.");
    console.log("Run `nova-ai-cli --setup` first to connect your Nova API key.");
    return;
  }

  if (!process.stdin.isTTY) {
    console.log("nova-ai-cli's interactive chat needs a real terminal (stdin is not a TTY).");
    console.log("Run it directly in a terminal, or use `nova-ai-cli --acp` for non-interactive/editor integration.");
    return;
  }

  const resumeIndex = args.indexOf("--resume");
  const resumeSessionId = resumeIndex !== -1 ? args[resumeIndex + 1] : undefined;

  const { waitUntilExit } = render(React.createElement(App, { credentials, cwd: process.cwd(), resumeSessionId }), {
    exitOnCtrlC: false,
  });
  await waitUntilExit();
}

export default runChat;
