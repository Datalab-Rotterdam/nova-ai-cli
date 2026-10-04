import * as acp from "@agentclientprotocol/sdk";
import type { NovaAgent } from "./agent.js";
import { NOVA_METHODS } from "./extensions.js";
import {
  parseJobIdParams,
  parseListParams,
  parseStartPromptParams,
  parseStartTerminalParams,
} from "../core/background.js";
import { isInteractionMode, type InteractionMode } from "../core/interaction-modes.js";
import {
  parseEnqueuePromptParams,
  parseQueueEntryParams,
  parseQueueSessionParams,
  parseUpdateQueuedPromptParams,
} from "../core/prompt-queue.js";
import {
  isValidSessionId,
  parseRewindSessionParams,
  parseSessionIdParams,
} from "../core/sessions.js";

/**
 * Every ACP method the agent serves, standard and _nova/ extensions. Used by
 * `nova-ai --acp` (stdio) and by the TUI and headless runner, which connect
 * in-process through the very same handlers.
 */
export function createAgentApp(agentImpl: NovaAgent): acp.AgentApp {
  return acp
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
    .onRequest(NOVA_METHODS.queueTakeNext, parseQueueSessionParams, (ctx) => ({
      entry: agentImpl.takeNextQueuedPrompt(ctx.params, ctx.client),
    }))
    .onRequest(NOVA_METHODS.sessionCompact, parseCompactParams, async (ctx) => {
      const { compacted, removedMessages, keptMessages } =
        await agentImpl.compactSession(ctx.params);
      return { compacted, removedMessages, keptMessages };
    })
    .onRequest(NOVA_METHODS.sessionContextUsage, parseContextUsageParams, (ctx) =>
      agentImpl.contextUsage(ctx.params),
    )
    .onRequest(NOVA_METHODS.sessionSetSettings, parseSetSettingsParams, (ctx) =>
      agentImpl.setSessionSettings(ctx.params),
    )
    .onNotification("session/cancel", (ctx) => agentImpl.cancel(ctx.params));
}

function parseCompactParams(params: unknown): { sessionId: string; model?: string } {
  const value = requireSessionParams(params);
  return {
    sessionId: value.sessionId,
    ...(typeof value.model === "string" && value.model ? { model: value.model } : {}),
  };
}

function parseContextUsageParams(params: unknown): {
  sessionId: string;
  contextWindow?: number | null;
  mode?: InteractionMode;
} {
  const value = requireSessionParams(params);
  if (value.mode !== undefined && !isInteractionMode(value.mode)) {
    throw acp.RequestError.invalidParams({ mode: value.mode }, "Unknown interaction mode.");
  }
  return {
    sessionId: value.sessionId,
    contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : null,
    ...(value.mode !== undefined ? { mode: value.mode as InteractionMode } : {}),
  };
}

function parseSetSettingsParams(params: unknown): { sessionId: string; settings: Record<string, unknown> } {
  const value = requireSessionParams(params);
  const settings = value.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw acp.RequestError.invalidParams({ settings }, "settings must be an object.");
  }
  return { sessionId: value.sessionId, settings: settings as Record<string, unknown> };
}

function requireSessionParams(params: unknown): Record<string, unknown> & { sessionId: string } {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw acp.RequestError.invalidParams(params, "params must be an object");
  }
  const value = params as Record<string, unknown>;
  if (!isValidSessionId(value.sessionId)) {
    throw acp.RequestError.invalidParams({ sessionId: value.sessionId }, "Invalid session id.");
  }
  return value as Record<string, unknown> & { sessionId: string };
}
