import { createInterface } from "node:readline/promises";
import { readCredentials } from "../core/credentials.js";
import { setWorkspaceTrusted } from "../core/nova-home.js";
import { runPiTui } from "./pi-app/app.js";
import { workspaceNeedsTrust } from "./settings/workspace-mcp.js";

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

  const cwd = process.cwd();
  if (workspaceNeedsTrust(cwd)) await askToTrust(cwd);

  await runPiTui(credentials, cwd, args);
}

/**
 * Asked once per workspace, and only when it declares MCP servers or allow
 * rules: both let the repository run commands, so a freshly cloned project
 * must not get them without the user saying so. The answer is remembered in
 * ~/.nova-ai (project.json), never in the repository.
 */
async function askToTrust(cwd: string): Promise<void> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n${cwd}`);
    console.log("This workspace declares MCP servers and/or permission allow rules in .mcp.json or .nova-ai/.");
    console.log("Trusting it starts those servers and applies those rules. Only trust code you know.");
    const answer = (await prompt.question("Trust this workspace? [y/N] ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      setWorkspaceTrusted(cwd, true);
    } else {
      console.log("Not trusted: its MCP servers stay off and its allow rules are ignored. Use /trust later to change this.");
    }
  } finally {
    prompt.close();
  }
}

export default runChat;
