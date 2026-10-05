import { createInterface } from "node:readline/promises";
import type { TuiOptions } from "../cli.js";
import { readCredentials } from "@datalabrotterdam/nova-ai-agent/core/credentials.js";
import { listStoredSessions, loadStoredSession } from "@datalabrotterdam/nova-ai-agent/core/sessions.js";
import { setWorkspaceTrusted } from "@datalabrotterdam/nova-ai-agent/core/nova-home.js";
import { checkForUpdate } from "../update-check.js";
import {
  installAndRestart,
  offerUpdateAtStart,
  UPDATED_FROM_ENV,
  withInstallability,
} from "../update-install.js";
import { cliVersion } from "../version.js";
import { runInkTui } from "./ink/app.js";
import { workspaceNeedsTrust } from "./settings/workspace-mcp.js";

export async function runChat(options: TuiOptions): Promise<number> {
  const stored = readCredentials();
  if (!stored) {
    console.error("nova-ai isn't connected to a Nova AI account yet. Run `nova-ai login` first.");
    return 1;
  }
  const credentials = options.model ? { ...stored, defaultModel: options.model } : stored;

  // One npm check per start: the prompt below and the TUI's reminder share it.
  const updateCheck = checkForUpdate().then((update) => withInstallability(update));
  const updatedFrom = process.env[UPDATED_FROM_ENV];
  if (updatedFrom) {
    // This is the restarted, updated process: say so, and don't ask again.
    delete process.env[UPDATED_FROM_ENV];
    console.log(`Updated nova-ai ${updatedFrom} → ${cliVersion() ?? "?"}.`);
  } else {
    const restartedCode = await offerUpdateAtStart(updateCheck, process.argv.slice(2));
    if (restartedCode !== null) return restartedCode;
  }

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
  const result = await runInkTui(credentials, cwd, args, { checkForUpdate: () => updateCheck });
  if (result.updateRequested) {
    const update = await updateCheck;
    if (update) {
      // Continue the same session in the new version (if it has been saved yet).
      const restartArgs = [
        ...(loadStoredSession(result.sessionId) ? ["--resume", result.sessionId] : []),
        ...(options.model ? ["--model", options.model] : []),
      ];
      const restartedCode = installAndRestart(update, restartArgs);
      if (restartedCode !== null) return restartedCode;
    }
  }
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
