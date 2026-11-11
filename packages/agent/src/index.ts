/**
 * @datalabrotterdam/nova-ai-agent: the Nova coding agent as an Agent Client
 * Protocol server.
 *
 * Most integrations start the `nova-ai-agent` command and speak ACP over its
 * stdin/stdout (see docs/ACP.md). This entry is for running the agent in the
 * same process: `startInProcessAgent` connects a real ACP client to it over
 * an in-memory stream, which is how the Nova terminal UI uses it. Deeper
 * modules are reachable as subpaths (`@datalabrotterdam/nova-ai-agent/core/…`)
 * for Nova's own front ends; only this entry is the stable API.
 */
export { NovaAgent } from "./acp/agent.js";
export { createAgentApp } from "./acp/server.js";
export { NOVA_METHODS, NOVA_NOTIFICATIONS, NOVA_EXTENSIONS_VERSION } from "./acp/extensions.js";
export { default as runAcp } from "./acp/index.js";
export { startInProcessAgent, type InProcessAgent } from "./client/in-process.js";
export { NovaAgentClient } from "./client/nova-agent-client.js";
export { runLogin, runLogout } from "./commands/login.js";
export { AGENT_PACKAGE_NAME, readPackageVersion } from "./core/version.js";
