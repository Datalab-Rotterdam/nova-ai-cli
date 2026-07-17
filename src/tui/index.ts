import { readCredentials } from "../acp/credentials.js";
import { runPiTui } from "./pi-app/app.js";

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

  await runPiTui(credentials, process.cwd(), args);
}

export default runChat;
