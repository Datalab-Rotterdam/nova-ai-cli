import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { NovaAgent } from "./agent.js";
import { NOVA_METHODS } from "./extensions.js";
import {
  parseJobIdParams,
  parseListParams,
  parseStartPromptParams,
  parseStartTerminalParams,
} from "../core/background.js";
import {
  parseEnqueuePromptParams,
  parseQueueEntryParams,
  parseQueueSessionParams,
  parseUpdateQueuedPromptParams,
} from "../core/prompt-queue.js";
import { parseRewindSessionParams, parseSessionIdParams } from "../core/sessions.js";
import { redirectConsoleToStderr } from "./stdio-guard.js";

async function runAcp(...args: string[]): Promise<void> {
  redirectConsoleToStderr();
  const agentImpl = new NovaAgent();

  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, input);

  const connection = acp
    .agent({ name: "nova-ai-cli" })
    .onRequest("initialize", (ctx) => agentImpl.initialize(ctx.params))
    .onRequest("session/new", (ctx) => agentImpl.newSession(ctx.params, ctx.client))
    .onRequest("session/load", (ctx) => agentImpl.loadSession(ctx.params, ctx.client))
    .onRequest("session/list", (ctx) => agentImpl.listSessions(ctx.params))
    .onRequest("session/set_mode", (ctx) =>
      agentImpl.setSessionMode(ctx.params),
    )
    .onRequest("session/close", (ctx) => agentImpl.closeSession(ctx.params))
    .onRequest("session/delete", (ctx) => agentImpl.deleteSession(ctx.params))
    .onRequest("session/fork", (ctx) => agentImpl.forkSession(ctx.params, ctx.client))
    .onRequest("session/resume", (ctx) =>
      agentImpl.resumeSession(ctx.params, ctx.client),
    )
    .onRequest(NOVA_METHODS.sessionCheckpoints, parseSessionIdParams, (ctx) =>
      agentImpl.listSessionCheckpoints(ctx.params),
    )
    .onRequest(NOVA_METHODS.sessionRewind, parseRewindSessionParams, (ctx) =>
      agentImpl.rewindSession(ctx.params, ctx.client),
    )
    .onRequest("session/set_config_option", (ctx) =>
      agentImpl.setSessionConfigOption(ctx.params),
    )
    .onRequest("authenticate", (ctx) => agentImpl.authenticate(ctx.params))
    .onRequest("session/prompt", (ctx) => agentImpl.prompt(ctx.params, ctx.client))
    .onRequest("providers/list", () => agentImpl.listProviders())
    .onRequest("providers/set", (ctx) => agentImpl.setProvider(ctx.params))
    .onRequest("providers/disable", (ctx) => agentImpl.disableProvider(ctx.params))
    .onRequest("nes/start", (ctx) => agentImpl.startNes(ctx.params))
    .onRequest("nes/suggest", (ctx) =>
      agentImpl.suggestNes(ctx.params, ctx.client, ctx.signal),
    )
    .onRequest("nes/close", (ctx) => agentImpl.closeNes(ctx.params))
    .onNotification("document/didOpen", (ctx) =>
      agentImpl.didOpenNesDocument(ctx.params),
    )
    .onNotification("document/didChange", (ctx) =>
      agentImpl.didChangeNesDocument(ctx.params),
    )
    .onNotification("document/didClose", (ctx) =>
      agentImpl.didCloseNesDocument(ctx.params),
    )
    .onNotification("nes/accept", (ctx) => agentImpl.acceptNes(ctx.params))
    .onNotification("nes/reject", (ctx) => agentImpl.rejectNes(ctx.params))
    .onRequest(NOVA_METHODS.backgroundStartTerminal, parseStartTerminalParams, (ctx) =>
      agentImpl.startBackgroundTerminal(ctx.params, ctx.client),
    )
    .onRequest(NOVA_METHODS.backgroundStartPrompt, parseStartPromptParams, (ctx) =>
      agentImpl.startBackgroundPrompt(ctx.params, ctx.client),
    )
    .onRequest(NOVA_METHODS.backgroundList, parseListParams, (ctx) => agentImpl.listBackgroundJobs(ctx.params))
    .onRequest(NOVA_METHODS.backgroundOutput, parseJobIdParams, (ctx) => agentImpl.backgroundOutput(ctx.params, ctx.client))
    .onRequest(NOVA_METHODS.backgroundKill, parseJobIdParams, (ctx) => agentImpl.killBackgroundJob(ctx.params, ctx.client))
    .onRequest(NOVA_METHODS.backgroundRelease, parseJobIdParams, (ctx) => agentImpl.releaseBackgroundJob(ctx.params, ctx.client))
    .onRequest(NOVA_METHODS.queueEnqueue, parseEnqueuePromptParams, (ctx) =>
      agentImpl.queuePrompt(ctx.params, ctx.client),
    )
    .onRequest(NOVA_METHODS.queueList, parseQueueSessionParams, (ctx) =>
      agentImpl.listPromptQueue(ctx.params),
    )
    .onRequest(NOVA_METHODS.queueEditBegin, parseQueueEntryParams, (ctx) =>
      agentImpl.beginQueuedPromptEdit(ctx.params, ctx.client),
    )
    .onRequest(NOVA_METHODS.queueUpdate, parseUpdateQueuedPromptParams, (ctx) =>
      agentImpl.updateQueuedPrompt(ctx.params, ctx.client),
    )
    .onRequest(NOVA_METHODS.queueRemove, parseQueueEntryParams, (ctx) =>
      agentImpl.removeQueuedPrompt(ctx.params, ctx.client),
    )
    .onRequest(NOVA_METHODS.queueClear, parseQueueSessionParams, (ctx) =>
      agentImpl.clearPromptQueue(ctx.params, ctx.client),
    )
    .onNotification("session/cancel", (ctx) => agentImpl.cancel(ctx.params))
    .connect(stream);

  installLifecycle(agentImpl, connection.closed);
  await connection.closed;
}

/**
 * The editor owns this process: when it closes stdin or signals us, cancel
 * running turns (they save their history), stop background agents and MCP
 * servers, and exit. A second signal exits immediately.
 */
function installLifecycle(agent: NovaAgent, closed: Promise<void>): void {
  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) process.exit(code);
    shuttingDown = true;
    const forced = setTimeout(() => process.exit(code), SHUTDOWN_TIMEOUT_MS);
    forced.unref();
    try {
      await agent.shutdown();
    } catch (error) {
      console.error("nova-ai-cli: error during shutdown:", error);
    }
    process.exit(code);
  };
  void closed.then(() => shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(130));
  process.on("unhandledRejection", (reason) => {
    // stderr only: stdout belongs to the JSON-RPC stream.
    console.error("nova-ai-cli: unhandled rejection:", reason);
  });
}

const SHUTDOWN_TIMEOUT_MS = 5_000;


export default runAcp;
