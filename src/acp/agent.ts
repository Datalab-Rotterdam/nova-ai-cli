import * as acp from "@agentclientprotocol/sdk";
import {
  NovaAI,
  NovaAIError,
  type ChatMessage,
} from "@datalabrotterdam/nova-sdk";
import type { AgentEvent } from "../core/agent-events.js";
import { buildModeSystemPrompt } from "../core/agent/mode-prompt.js";
import type { Session } from "../core/agent/session.js";
import { buildSessionTools } from "../core/agent/session-tools.js";
import { chatContentToText } from "../core/chat-content.js";
import {
  calculateContextUsage,
  type ContextUsage,
} from "../core/context-usage.js";
import {
  compactConversation,
  contextWindowFromError,
  type ContextCompactionResult,
} from "../core/context-compaction.js";
import { readCredentials } from "../core/credentials.js";
import {
  isInteractionMode,
  type InteractionMode,
} from "../core/interaction-modes.js";
import {
  closeMcpConnections,
  connectMcpServers,
  listMcpTools,
  type McpConnection,
  type McpConnectionFailure,
} from "../core/mcp.js";
import { buildMemorySystemPrompt, discoverMemories } from "../core/memory.js";
import { PromptQueue } from "../core/prompt-queue.js";
import { stripReasoningTags } from "../core/reasoning-tags.js";
import { runTurn } from "../core/run-turn.js";
import {
  appendSessionCompaction,
  appendSessionTurn,
  deleteStoredSession,
  deriveTitle,
  forkStoredSession,
  listSessionCheckpoints as listStoredSessionCheckpoints,
  listStoredSessions,
  loadStoredSession,
  rewindStoredSession,
  type RewindSessionParams,
  type SessionIdParams,
} from "../core/sessions.js";
import {
  buildSkillsSystemPrompt,
  discoverSkills,
  type SkillDefinition,
} from "../core/skills.js";
import { detectToolEnvironment } from "../core/tools/environment.js";
import { stripToolCallMarkup } from "../core/tools/marker.js";
import { buildToolsSystemPrompt } from "../core/tools/system-prompt.js";
import type { ToolDefinition } from "../core/tools/types.js";
import { AcpToolHost } from "./acp-tool-host.js";
import {
  emitToAcp,
  notifyPlanUpdate,
  requestAcpPermission,
  sessionStatusMeta,
} from "./acp-emit.js";
import type { AgentRuntime } from "./agent-runtime.js";
import { runBrowserAuth } from "./auth-server.js";
import { BackgroundService } from "./background-service.js";
import { ModelService } from "./model-service.js";
import { NesService } from "./nes-service.js";
import { selectPositionEncoding } from "./nes.js";
import {
  contentBlocksToNovaContent,
  getPromptModel,
} from "./prompt-content.js";
import { QueueService } from "./queue-service.js";
import { sessionModeState } from "./session-modes.js";
import type {
  BackgroundJobSummary,
  BackgroundToolApi,
  JobIdParams,
  ListParams,
  OutputResponse,
  StartPromptParams,
  StartTerminalParams,
} from "../core/background.js";
import type {
  EnqueuePromptParams,
  PromptQueueEntry,
  PromptQueueEntryView,
  QueueEntryParams,
  QueueSessionParams,
  UpdateQueuedPromptParams,
} from "../core/prompt-queue.js";

export {
  contentBlocksToNovaContent,
  contentBlocksToText,
  frameSteeringPrompt,
} from "./prompt-content.js";

const AUTH_METHOD_ID = "nova-api-key";

export type PromptRuntimeOptions = {
  /** @deprecated Queue steering through queue/enqueue or queuePrompt instead. */
  takeSteeringMessages?(): ChatMessage[] | Promise<ChatMessage[]>;
};

export class NovaAgent implements AgentRuntime {
  private readonly sessions = new Map<string, Session>();
  clientCapabilities: acp.ClientCapabilities | undefined;
  positionEncoding: acp.PositionEncodingKind = "utf-16";
  readonly models = new ModelService();
  private readonly nes = new NesService(this);
  private readonly queue = new QueueService(this);
  private readonly background = new BackgroundService(this);

  initialize(params: acp.InitializeRequest): acp.InitializeResponse {
    this.clientCapabilities = params.clientCapabilities;
    this.positionEncoding = selectPositionEncoding(
      params.clientCapabilities?.positionEncodings,
    );
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        sessionCapabilities: {
          list: {},
          close: {},
          delete: {},
          fork: {},
          resume: {},
        },
        providers: {},
        nes: {
          events: {
            document: {
              didOpen: {},
              didChange: { syncKind: "full" },
              didClose: {},
            },
          },
          context: {
            recentFiles: { maxCount: 5 },
            relatedSnippets: {},
            editHistory: { maxCount: 8 },
            openFiles: {},
            diagnostics: {},
          },
        },
        positionEncoding: this.positionEncoding,
      },
      authMethods: [
        {
          id: AUTH_METHOD_ID,
          name: "Nova API Key",
          description:
            "Opens a local page in your browser to connect your DataLab Rotterdam Nova AI account.",
        },
      ],
    };
  }

  async newSession(
    params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    const { mcpConnections, mcpFailures, skills } = await this.setupSession(
      sessionId,
      params,
      [],
      null,
    );
    return {
      sessionId,
      modes: sessionModeState("agent"),
      _meta: sessionStatusMeta(
        params.mcpServers,
        mcpConnections,
        mcpFailures,
        skills,
      ),
    };
  }

  /**
   * Shared MCP-connect/environment-detect/skills-discover setup used by every
   * way a session comes to life (new, load, resume, fork).
   */
  private async setupSession(
    sessionId: string,
    params: { cwd: string; mcpServers?: acp.McpServer[] },
    history: ChatMessage[],
    title: string | null,
  ): Promise<{
    mcpConnections: McpConnection[];
    mcpFailures: McpConnectionFailure[];
    skills: SkillDefinition[];
  }> {
    const connectedMcp = await connectMcpServers(params.mcpServers ?? []);
    const loadedMcp = await listMcpTools(connectedMcp.connections);
    const mcpConnections = loadedMcp.connections;
    const mcpFailures = [...connectedMcp.failures, ...loadedMcp.failures];
    const mcpTools = loadedMcp.tools;
    const environment = await detectToolEnvironment(
      params.cwd,
      this.clientCapabilities,
    );
    const skills = discoverSkills(params.cwd);
    const memory = discoverMemories(params.cwd);
    this.sessions.set(sessionId, {
      pendingPrompt: null,
      promptQueue: new PromptQueue(),
      cwd: params.cwd,
      history,
      pendingBackgroundHandoffs: [],
      title,
      mcpConnections,
      mcpTools,
      mcpFailures,
      environment,
      skills,
      memory,
      mode: "agent",
      model: null,
    });
    return { mcpConnections, mcpFailures, skills };
  }

  async loadSession(
    params: acp.LoadSessionRequest,
    client: acp.AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    const stored = loadStoredSession(params.sessionId);
    if (!stored) {
      throw acp.RequestError.internalError(
        undefined,
        `Session ${params.sessionId} not found`,
      );
    }

    const { mcpConnections, mcpFailures, skills } = await this.setupSession(
      params.sessionId,
      params,
      stored.messages,
      stored.title,
    );

    for (const message of stored.messages) {
      const rawText = chatContentToText(message.content);
      const text =
        message.role === "assistant"
          ? stripReasoningTags(stripToolCallMarkup(rawText))
          : rawText;
      if (!text) continue;
      if (message.role === "user") {
        await client.notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text },
          },
        });
      } else if (message.role === "assistant") {
        await client.notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });
      }
    }

    return {
      modes: sessionModeState("agent"),
      _meta: sessionStatusMeta(
        params.mcpServers,
        mcpConnections,
        mcpFailures,
        skills,
      ),
    };
  }

  listSessions(params: acp.ListSessionsRequest): acp.ListSessionsResponse {
    const sessions = listStoredSessions(params.cwd ?? undefined).map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt,
    }));
    return { sessions };
  }

  listSessionCheckpoints(params: SessionIdParams): {
    checkpoints: ReturnType<typeof listStoredSessionCheckpoints>;
  } {
    this.requireSession(params.sessionId);
    return { checkpoints: listStoredSessionCheckpoints(params.sessionId) };
  }

  async rewindSession(
    params: RewindSessionParams,
    client?: acp.AgentContext,
  ): Promise<{
    removedCheckpoints: ReturnType<typeof listStoredSessionCheckpoints>;
    remainingCheckpoints: ReturnType<typeof listStoredSessionCheckpoints>;
    messageCount: number;
  }> {
    const session = this.requireSession(params.sessionId);
    if (session.pendingPrompt) {
      throw new Error("Cannot rewind while a request is active.");
    }
    const result = rewindStoredSession(params.sessionId, params.turns ?? 1);
    if (!result) {
      throw new Error(`Session ${params.sessionId} has no persisted history.`);
    }

    session.history = result.session.messages;
    session.title = result.session.title;
    session.pendingBackgroundHandoffs.length = 0;
    session.promptQueue.clear();
    await this.queue.notifyPromptQueue(params.sessionId, [], client);
    await client
      ?.notify("session/rewound", {
        sessionId: params.sessionId,
        removedCheckpoints: result.removedCheckpoints,
        remainingCheckpoints: result.remainingCheckpoints,
        messageCount: session.history.length,
      })
      .catch(() => {});
    return {
      removedCheckpoints: result.removedCheckpoints,
      remainingCheckpoints: result.remainingCheckpoints,
      messageCount: session.history.length,
    };
  }

  setSessionMode(
    params: acp.SetSessionModeRequest,
  ): acp.SetSessionModeResponse {
    const session = this.requireSession(params.sessionId);
    if (!isInteractionMode(params.modeId)) {
      throw acp.RequestError.invalidParams(
        { modeId: params.modeId },
        `Unknown interaction mode: ${params.modeId}`,
      );
    }
    session.mode = params.modeId;
    return {};
  }

  async deleteSession(
    params: acp.DeleteSessionRequest,
  ): Promise<acp.DeleteSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.pendingPrompt?.abort();
      await closeMcpConnections(session.mcpConnections);
      this.sessions.delete(params.sessionId);
    }
    deleteStoredSession(params.sessionId);
    return {};
  }

  async forkSession(
    params: acp.ForkSessionRequest,
  ): Promise<acp.ForkSessionResponse> {
    const newSessionId = crypto.randomUUID();
    const forked = forkStoredSession(params.sessionId, newSessionId, {
      cwd: params.cwd,
    });
    if (!forked) {
      throw acp.RequestError.internalError(
        undefined,
        `Session ${params.sessionId} not found`,
      );
    }
    await this.setupSession(
      newSessionId,
      params,
      forked.messages,
      forked.title,
    );
    return {
      sessionId: newSessionId,
      modes: sessionModeState("agent"),
      configOptions: await this.models.buildConfigOptions(
        this.requireSession(newSessionId),
      ),
    };
  }

  async resumeSession(
    params: acp.ResumeSessionRequest,
  ): Promise<acp.ResumeSessionResponse> {
    const stored = loadStoredSession(params.sessionId);
    if (!stored) {
      throw acp.RequestError.internalError(
        undefined,
        `Session ${params.sessionId} not found`,
      );
    }
    await this.setupSession(
      params.sessionId,
      params,
      stored.messages,
      stored.title,
    );
    return {
      modes: sessionModeState("agent"),
      configOptions: await this.models.buildConfigOptions(
        this.requireSession(params.sessionId),
      ),
    };
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId);
    if (params.configId !== "model") {
      throw acp.RequestError.invalidParams(
        params,
        `Unknown config option: ${params.configId}`,
      );
    }
    if (typeof params.value !== "string" || !params.value) {
      throw acp.RequestError.invalidParams(
        params,
        "model config option requires a non-empty string value id",
      );
    }
    session.model = params.value;
    return { configOptions: await this.models.buildConfigOptions(session) };
  }

  contextUsage(params: {
    sessionId: string;
    contextWindow?: number | null;
    mode?: InteractionMode;
  }): ContextUsage {
    const session = this.requireSession(params.sessionId);
    const mode = params.mode === undefined ? session.mode : params.mode;
    const tools = buildSessionTools(session, this.clientCapabilities, {
      mode,
      updatePlan: () => {},
      enterPlanMode: () => {},
    });
    return calculateContextUsage({
      history: session.history,
      systemPrompt: buildModeSystemPrompt(mode),
      skillsPrompt: buildSkillsSystemPrompt(session.skills),
      memoryPrompt: buildMemorySystemPrompt(session.memory),
      toolsPrompt: buildToolsSystemPrompt(tools, session.cwd),
      contextWindow: params.contextWindow,
    });
  }

  async authenticate(
    params: acp.AuthenticateRequest,
  ): Promise<acp.AuthenticateResponse> {
    if (params.methodId !== AUTH_METHOD_ID) {
      throw new Error(`Unknown auth method: ${params.methodId}`);
    }
    await runBrowserAuth();
    return {};
  }

  async compactSession(params: {
    sessionId: string;
    model?: string;
  }): Promise<ContextCompactionResult> {
    const session = this.requireSession(params.sessionId);
    if (session.pendingPrompt) {
      throw new Error("Cannot compact context while a request is active.");
    }
    const credentials = readCredentials();
    if (!credentials) throw acp.RequestError.authRequired();
    const model =
      params.model ?? credentials.defaultModel ?? process.env.NOVA_MODEL;
    if (!model)
      throw new Error(
        "No Nova model configured. Re-run authentication or set NOVA_MODEL.",
      );

    const novaClient = new NovaAI({ apiKey: credentials.apiKey });
    const contextWindow = await this.models.resolveContextWindow(novaClient, model);
    const result = await compactConversation(
      session.history,
      novaClient,
      model,
      { contextWindow },
    );
    if (result.compacted) {
      session.history = result.history;
      session.title ??= deriveTitle(session.history);
      appendSessionCompaction(
        params.sessionId,
        { cwd: session.cwd, title: session.title },
        session.history,
      );
    }
    return result;
  }

  async prompt(
    params: acp.PromptRequest,
    client: acp.AgentContext,
    runtime: PromptRuntimeOptions = {},
  ): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    const credentials = readCredentials();
    if (!credentials) {
      throw acp.RequestError.authRequired();
    }
    await notifyPlanUpdate(client, params.sessionId, []);

    session.pendingPrompt?.abort();
    const abortController = new AbortController();
    session.pendingPrompt = abortController;

    const novaClient = new NovaAI({ apiKey: credentials.apiKey });
    const model =
      getPromptModel(params) ??
      session.model ??
      credentials.defaultModel ??
      process.env.NOVA_MODEL;
    if (!model) {
      throw new Error(
        "No Nova model configured. Re-run authentication or set NOVA_MODEL.",
      );
    }
    await this.models.assertImageInputSupported(novaClient, model, params.prompt);
    const contextWindow = await this.models.resolveContextWindow(novaClient, model);

    session.environment = await detectToolEnvironment(
      session.cwd,
      this.clientCapabilities,
    );
    session.skills = discoverSkills(session.cwd);
    session.memory = discoverMemories(session.cwd);
    const background = this.background.createBackgroundToolApi(params.sessionId, client);
    const tools = buildSessionTools(session, this.clientCapabilities, {
      mode: session.mode,
      updatePlan: (entries) =>
        notifyPlanUpdate(client, params.sessionId, entries),
      enterPlanMode: async () => {
        session.mode = "plan";
        await client
          .notify("session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: "plan",
            },
          })
          .catch(() => {
            // The server-side least-privilege transition remains active
            // even if the client disconnects before rendering the update.
          });
      },
    });
    const systemPrompt = [
      buildModeSystemPrompt(session.mode),
      buildSkillsSystemPrompt(session.skills),
      buildMemorySystemPrompt(session.memory),
      buildToolsSystemPrompt(tools, session.cwd),
    ]
      .filter(Boolean)
      .join("\n\n");

    const userMessage: ChatMessage = {
      role: "user",
      content: contentBlocksToNovaContent(params.prompt),
    };
    // Finished background jobs hand their notes to the next foreground turn
    // here, keeping history and the session file in the order the model saw.
    const backgroundHandoffs = session.pendingBackgroundHandoffs.splice(0);
    session.history.push(...backgroundHandoffs, userMessage);

    const messages: ChatMessage[] = [
      ...(systemPrompt
        ? [{ role: "system" as const, content: systemPrompt }]
        : []),
      ...session.history,
    ];
    const systemMessageCount = systemPrompt ? 1 : 0;

    const host = new AcpToolHost(client, params.sessionId);
    const emit = (event: AgentEvent) =>
      emitToAcp(client, params.sessionId, event);
    const requestPermission = (
      toolCallId: string,
      tool: ToolDefinition,
      args: Record<string, unknown>,
    ) =>
      requestAcpPermission(
        client,
        params.sessionId,
        abortController.signal,
        toolCallId,
        tool,
        args,
      );

    let turnMessages: ChatMessage[] = [];
    let contextCompacted = false;
    try {
      const result = await runTurn(messages, abortController.signal, {
        host,
        sessionId: params.sessionId,
        cwd: session.cwd,
        environment: session.environment,
        background,
        tools,
        requestPermission,
        compactContext: async (currentMessages, error) => {
          const compaction = await compactConversation(
            currentMessages.slice(systemMessageCount),
            novaClient,
            model,
            {
              signal: abortController.signal,
              contextWindow: contextWindowFromError(error) ?? contextWindow,
            },
          );
          if (compaction.compacted) {
            currentMessages.splice(
              systemMessageCount,
              currentMessages.length - systemMessageCount,
              ...compaction.history,
            );
            contextCompacted = true;
          }
          return compaction;
        },
        contextWindow,
        takeSteeringMessages: async () => [
          ...(await this.takeSteeringMessages(
            { sessionId: params.sessionId },
            client,
          )),
          ...((await runtime.takeSteeringMessages?.()) ?? []),
        ],
        emit,
        novaClient,
        model,
      });
      turnMessages = result.turnMessages;
      return { stopReason: result.stopReason };
    } catch (err) {
      if (abortController.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      if (err instanceof NovaAIError) {
        throw new Error(
          `Nova AI request failed (status ${err.status}, requestId ${err.requestId}): ${err.message}`,
        );
      }
      throw err;
    } finally {
      session.pendingPrompt = null;
      if (contextCompacted) {
        session.history = messages.slice(systemMessageCount);
        session.title ??= deriveTitle(session.history);
        appendSessionCompaction(
          params.sessionId,
          { cwd: session.cwd, title: session.title },
          session.history,
        );
      } else {
        session.history.push(...turnMessages);
        session.title ??= deriveTitle(session.history);
        appendSessionTurn(
          params.sessionId,
          { cwd: session.cwd, title: session.title },
          [...backgroundHandoffs, userMessage, ...turnMessages],
        );
      }
    }
  }

  cancel(params: acp.CancelNotification): void {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }

  async closeSession(
    params: acp.CloseSessionRequest,
  ): Promise<acp.CloseSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.pendingPrompt?.abort();
      await closeMcpConnections(session.mcpConnections);
      this.sessions.delete(params.sessionId);
    }
    return {};
  }

  requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return session;
  }

  startNes(params: acp.StartNesRequest): acp.StartNesResponse {
    return this.nes.startNes(params);
  }

  suggestNes(
    params: acp.SuggestNesRequest,
    client: acp.AgentContext,
    requestSignal?: AbortSignal,
  ): Promise<acp.SuggestNesResponse> {
    return this.nes.suggestNes(params, client, requestSignal);
  }

  closeNes(params: acp.CloseNesRequest): acp.CloseNesResponse {
    return this.nes.closeNes(params);
  }

  acceptNes(params: acp.AcceptNesNotification): void {
    return this.nes.acceptNes(params);
  }

  rejectNes(params: acp.RejectNesNotification): void {
    return this.nes.rejectNes(params);
  }

  didOpenNesDocument(params: acp.DidOpenDocumentNotification): void {
    return this.nes.didOpenNesDocument(params);
  }

  didChangeNesDocument(params: acp.DidChangeDocumentNotification): void {
    return this.nes.didChangeNesDocument(params);
  }

  didCloseNesDocument(params: acp.DidCloseDocumentNotification): void {
    return this.nes.didCloseNesDocument(params);
  }

  listProviders(): Promise<acp.ListProvidersResponse> {
    return this.models.listProviders();
  }

  setProvider(
    params: acp.SetProviderRequest,
  ): Promise<acp.SetProviderResponse> {
    return this.models.setProvider(params);
  }

  disableProvider(
    params: acp.DisableProviderRequest,
  ): acp.DisableProviderResponse {
    return this.models.disableProvider(params);
  }

  queuePrompt(
    params: EnqueuePromptParams,
    client?: acp.AgentContext,
  ): { entry: PromptQueueEntryView; entries: PromptQueueEntryView[] } {
    return this.queue.queuePrompt(params, client);
  }

  listPromptQueue(params: QueueSessionParams): {
    entries: PromptQueueEntryView[];
  } {
    return this.queue.listPromptQueue(params);
  }

  beginQueuedPromptEdit(
    params: QueueEntryParams,
    client?: acp.AgentContext,
  ): { updated: boolean; entries: PromptQueueEntryView[] } {
    return this.queue.beginQueuedPromptEdit(params, client);
  }

  updateQueuedPrompt(
    params: UpdateQueuedPromptParams,
    client?: acp.AgentContext,
  ): { updated: boolean; entries: PromptQueueEntryView[] } {
    return this.queue.updateQueuedPrompt(params, client);
  }

  removeQueuedPrompt(
    params: QueueEntryParams,
    client?: acp.AgentContext,
  ): { removed: boolean; entries: PromptQueueEntryView[] } {
    return this.queue.removeQueuedPrompt(params, client);
  }

  clearPromptQueue(
    params: QueueSessionParams,
    client?: acp.AgentContext,
  ): { cleared: number; entries: PromptQueueEntryView[] } {
    return this.queue.clearPromptQueue(params, client);
  }

  takeNextQueuedPrompt(
    params: QueueSessionParams,
    client?: acp.AgentContext,
  ): PromptQueueEntry | null {
    return this.queue.takeNextQueuedPrompt(params, client);
  }

  takeSteeringMessages(
    params: QueueSessionParams,
    client: acp.AgentContext,
  ): Promise<ChatMessage[]> {
    return this.queue.takeSteeringMessages(params, client);
  }

  startBackgroundTerminal(
    params: StartTerminalParams,
    client: acp.AgentContext,
  ): Promise<{ job: BackgroundJobSummary }> {
    return this.background.startBackgroundTerminal(params, client);
  }

  createBackgroundToolApi(
    sessionId: string,
    client: acp.AgentContext,
  ): BackgroundToolApi {
    return this.background.createBackgroundToolApi(sessionId, client);
  }

  startBackgroundPrompt(
    params: StartPromptParams,
    client: acp.AgentContext,
  ): Promise<{ job: BackgroundJobSummary }> {
    return this.background.startBackgroundPrompt(params, client);
  }

  listBackgroundJobs(params: ListParams): { jobs: BackgroundJobSummary[] } {
    return this.background.listBackgroundJobs(params);
  }

  backgroundOutput(
    params: JobIdParams,
    client: acp.AgentContext,
  ): Promise<OutputResponse> {
    return this.background.backgroundOutput(params, client);
  }

  killBackgroundJob(
    params: JobIdParams,
    client: acp.AgentContext,
  ): Promise<{ job: BackgroundJobSummary }> {
    return this.background.killBackgroundJob(params, client);
  }

  releaseBackgroundJob(
    params: JobIdParams,
    client: acp.AgentContext,
  ): Promise<{ job: BackgroundJobSummary }> {
    return this.background.releaseBackgroundJob(params, client);
  }

}

