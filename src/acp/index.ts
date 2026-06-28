import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { NovaAgent } from "./agent.js";
import {
  parseJobIdParams,
  parseListParams,
  parseStartPromptParams,
  parseStartTerminalParams,
} from "./background.js";

async function runAcp(...args: string[]): Promise<void> {
  const agentImpl = new NovaAgent();

  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, input);

  acp
    .agent({ name: "nova-ai-cli" })
    .onRequest("initialize", (ctx) => agentImpl.initialize(ctx.params))
    .onRequest("session/new", (ctx) => agentImpl.newSession(ctx.params))
    .onRequest("session/load", (ctx) => agentImpl.loadSession(ctx.params, ctx.client))
    .onRequest("session/list", (ctx) => agentImpl.listSessions(ctx.params))
    .onRequest("session/close", (ctx) => agentImpl.closeSession(ctx.params))
    .onRequest("authenticate", (ctx) => agentImpl.authenticate(ctx.params))
    .onRequest("session/prompt", (ctx) => agentImpl.prompt(ctx.params, ctx.client))
    .onRequest("background/start_terminal", parseStartTerminalParams, (ctx) =>
      agentImpl.startBackgroundTerminal(ctx.params, ctx.client),
    )
    .onRequest("background/start_prompt", parseStartPromptParams, (ctx) =>
      agentImpl.startBackgroundPrompt(ctx.params, ctx.client),
    )
    .onRequest("background/list", parseListParams, (ctx) => agentImpl.listBackgroundJobs(ctx.params))
    .onRequest("background/output", parseJobIdParams, (ctx) => agentImpl.backgroundOutput(ctx.params, ctx.client))
    .onRequest("background/kill", parseJobIdParams, (ctx) => agentImpl.killBackgroundJob(ctx.params, ctx.client))
    .onRequest("background/release", parseJobIdParams, (ctx) => agentImpl.releaseBackgroundJob(ctx.params, ctx.client))
    .onNotification("session/cancel", (ctx) => agentImpl.cancel(ctx.params))
    .connect(stream);
}


export default runAcp;
