import type * as acp from "@agentclientprotocol/sdk";
import { NOVA_METHODS } from "../acp/extensions.js";
import type {
  BackgroundJobSummary,
  JobIdParams,
  ListParams,
  OutputResponse,
  StartPromptParams,
  StartTerminalParams,
} from "../core/background.js";
import type { ContextUsage } from "../core/context-usage.js";
import type { InteractionMode } from "../core/interaction-modes.js";
import type {
  EnqueuePromptParams,
  PromptQueueEntry,
  PromptQueueEntryView,
  QueueEntryParams,
  QueueSessionParams,
  UpdateQueuedPromptParams,
} from "../core/prompt-queue.js";
import type { SessionCheckpoint } from "../core/sessions.js";

type Entries = { entries: PromptQueueEntryView[] };

/**
 * A typed client for Nova's ACP agent: the standard methods of the SDK
 * connection plus Nova's _nova/ extensions. Everything goes over ACP.
 */
export class NovaAgentClient {
  constructor(readonly connection: acp.ClientSideConnection) {}

  initialize(params: acp.InitializeRequest) {
    return this.connection.initialize(params);
  }
  newSession(params: acp.NewSessionRequest) {
    return this.connection.newSession(params);
  }
  loadSession(params: acp.LoadSessionRequest) {
    return this.connection.loadSession(params);
  }
  resumeSession(params: acp.ResumeSessionRequest) {
    return this.connection.resumeSession(params);
  }
  closeSession(params: acp.CloseSessionRequest) {
    return this.connection.closeSession(params);
  }
  prompt(params: acp.PromptRequest) {
    return this.connection.prompt(params);
  }
  cancel(params: acp.CancelNotification) {
    return this.connection.cancel(params);
  }
  setSessionMode(params: acp.SetSessionModeRequest) {
    return this.connection.setSessionMode(params);
  }
  setSessionConfigOption(params: acp.SetSessionConfigOptionRequest) {
    return this.connection.setSessionConfigOption(params);
  }

  queueEnqueue(params: EnqueuePromptParams) {
    return this.ext<{ entry: PromptQueueEntryView } & Entries>(NOVA_METHODS.queueEnqueue, params);
  }
  queueList(params: QueueSessionParams) {
    return this.ext<Entries>(NOVA_METHODS.queueList, params);
  }
  queueEditBegin(params: QueueEntryParams) {
    return this.ext<{ updated: boolean } & Entries>(NOVA_METHODS.queueEditBegin, params);
  }
  queueUpdate(params: UpdateQueuedPromptParams) {
    return this.ext<{ updated: boolean } & Entries>(NOVA_METHODS.queueUpdate, params);
  }
  queueRemove(params: QueueEntryParams) {
    return this.ext<{ removed: boolean } & Entries>(NOVA_METHODS.queueRemove, params);
  }
  queueClear(params: QueueSessionParams) {
    return this.ext<{ cleared: number } & Entries>(NOVA_METHODS.queueClear, params);
  }
  queueTakeNext(params: QueueSessionParams) {
    return this.ext<{ entry: PromptQueueEntry | null }>(NOVA_METHODS.queueTakeNext, params);
  }

  sessionCompact(params: { sessionId: string; model?: string }) {
    return this.ext<{ compacted: boolean; removedMessages: number; keptMessages: number }>(
      NOVA_METHODS.sessionCompact,
      params,
    );
  }
  sessionContextUsage(params: {
    sessionId: string;
    contextWindow?: number | null;
    mode?: InteractionMode;
  }) {
    return this.ext<ContextUsage>(NOVA_METHODS.sessionContextUsage, params);
  }
  sessionRewind(params: { sessionId: string; turns?: number }) {
    return this.ext<{
      removedCheckpoints: SessionCheckpoint[];
      remainingCheckpoints: SessionCheckpoint[];
      messageCount: number;
    }>(NOVA_METHODS.sessionRewind, params);
  }

  backgroundStartTerminal(params: StartTerminalParams) {
    return this.ext<{ job: BackgroundJobSummary }>(NOVA_METHODS.backgroundStartTerminal, params);
  }
  backgroundStartPrompt(params: StartPromptParams) {
    return this.ext<{ job: BackgroundJobSummary }>(NOVA_METHODS.backgroundStartPrompt, params);
  }
  backgroundList(params: ListParams) {
    return this.ext<{ jobs: BackgroundJobSummary[] }>(NOVA_METHODS.backgroundList, params);
  }
  backgroundOutput(params: JobIdParams) {
    return this.ext<OutputResponse>(NOVA_METHODS.backgroundOutput, params);
  }
  backgroundKill(params: JobIdParams) {
    return this.ext<{ job: BackgroundJobSummary }>(NOVA_METHODS.backgroundKill, params);
  }
  backgroundRelease(params: JobIdParams) {
    return this.ext<{ job: BackgroundJobSummary }>(NOVA_METHODS.backgroundRelease, params);
  }

  private async ext<T>(method: string, params: object): Promise<T> {
    return (await this.connection.extMethod(method, params as Record<string, unknown>)) as T;
  }
}
