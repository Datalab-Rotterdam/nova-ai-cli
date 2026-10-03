import { createInterface } from "node:readline/promises";
import type { TuiOptions } from "../cli.js";
import { readCredentials } from "../core/credentials.js";
import { listStoredSessions } from "../core/sessions.js";
import { setWorkspaceTrusted } from "../core/nova-home.js";
import { runInkTui } from "./ink/app.js";
import { workspaceNeedsTrust } from "./settings/workspace-mcp.js";

export async function runChat(options: TuiOptions): Promise<number> {
  const stored = readCredentials();
  if (!stored) {
    console.error("nova-ai isn't connected to a Nova AI account yet. Run `nova-ai login` first.");
    return 1;
  }
  const credentials = options.model ? { ...stored, defaultModel: options.model } : stored;

  const cwd = process.cwd();
  let resume = options.resume;
  if (options.continueLast) {
    resume = listStoredSessions(cwd)[0]?.sessionId ?? null;
    if (!resume) {
      console.error(`No earlier session in ${cwd} to continue.`);
      return 1;
    }
  }

  if (workspaceNeedsTrust(cwd)) await askToTrust(cwd);

  const args = resume ? ["--resume", resume] : [];
  await runInkTui(credentials, cwd, args);
  return 0;
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
