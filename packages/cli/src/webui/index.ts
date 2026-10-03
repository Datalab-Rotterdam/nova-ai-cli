/**
 * Placeholder for the standalone browser-based agent UI (nova-ai-cli --web),
 * separate from src/acp/web which only handles the --setup auth page.
 */
async function runWebUi(): Promise<void> {
  console.log("nova-ai --web is a work in progress — the browser UI isn't built yet.");
  console.log("Use `nova-ai` for the terminal UI, `nova-ai -p` headless, or `nova-ai --acp` for editors.");
}

export default runWebUi;
