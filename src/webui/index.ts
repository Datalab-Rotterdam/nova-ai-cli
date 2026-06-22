/**
 * Placeholder for the standalone browser-based agent UI (nova-ai-cli --web),
 * separate from src/acp/web which only handles the --setup auth page.
 */
async function runWebUi(...args: string[]): Promise<void> {
  console.log("nova-ai-cli --web is a work in progress — the browser UI isn't built yet.");
  console.log("Use `nova-ai-cli` for the terminal chat, or `nova-ai-cli --acp` for ACP mode.");
}

export default runWebUi;
