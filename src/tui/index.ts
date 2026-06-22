/**
 * Placeholder for the interactive terminal chat mode (nova-ai-cli's primary
 * entrypoint, mirroring `claude`/`codex`). ACP mode in index.ts is the
 * machine-facing counterpart of this same auth/credentials plumbing.
 */
export async function runChat(...args: string[]): Promise<void> {
  console.log("nova-ai-cli is a work in progress — interactive chat isn't built yet.");
  console.log("Right now it only works in ACP mode: run `nova-ai-cli --acp` (or point your ACP client at this binary).");
  console.log("Run `nova-ai-cli --setup` first to connect your Nova API key.");
}

export default runChat;
