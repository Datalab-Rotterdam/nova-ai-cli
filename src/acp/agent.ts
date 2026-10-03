import * as acp from "@agentclientprotocol/sdk";
import { NOVA_NOTIFICATIONS, novaExtensionsMeta } from "./extensions.js";
import { NovaAI, type ChatMessage } from "@datalabrotterdam/nova-sdk";
import { createNovaClient } from "../core/nova-client.js";
import type { AgentEvent } from "../core/agent-events.js";
import { buildModeSystemPrompt } from "../core/agent/mode-prompt.js";
import type { Session } from "../core/agent/session.js";
import { buildSessionTools } from "../core/agent/session-tools.js";
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
import { buildMemorySystemPrompt, loadMemory } from "../core/memory.js";
import { PromptQueue } from "../core/prompt-queue.js";
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
import {
  buildNativeToolsSystemPrompt,
  buildToolsSystemPrompt,
} from "../core/tools/system-prompt.js";
import {
  chooseToolProtocol,
  runWithToolProtocol,
  type ToolProtocol,
} from "../core/agent/tool-protocol.js";
import type { ToolDefinition } from "../core/tools/types.js";
import { AcpToolHost } from "./acp-tool-host.js";
import { readPackageVersion } from "../core/version.js";
import { replayHistory, type ReplayItem } from "../core/history.js";
import { describeToolCall, toolKindOf } from "../core/tools/describe.js";
import { sessionNotFound, toAcpError } from "./errors.js";
import {
  emitToAcp,
  notifyPlanUpdate,
  sessionStatusMeta,
} from "./acp-emit.js";
import { authorizeToolCall } from "./permission-flow.js";
import {
  PERMISSION_MODE_CONFIG_ID,
  permissionModeOption,
} from "./session-modes.js";
import { PermissionPolicy } from "../core/policy/policy.js";
import {
  isPermissionMode,
  PERMISSION_MODES,
} from "../core/policy/settings.js";
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
const ENV_AUTH_METHOD_ID = "nova-api-key-env";
const TERMINAL_AUTH_METHOD_ID = "nova-login-terminal";

/** Slash commands the agent itself handles in session/prompt. */
const AVAILABLE_COMMANDS: acp.AvailableCommand[] = [
  {
    name: "compact",
    description: "Summarize older parts of the conversation to free context space",
  },
];

const REPLAYED_OUTPUT_CHARS = 4_000;
const SESSION_PAGE_SIZE = 50;

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const { offset } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Number.isSafeInteger(offset) && offset >= 0) return offset;
  } catch {
    // fall through
  }
  throw acp.RequestError.invalidParams({ cursor }, "Invalid session list cursor.");
}

function replayedToolCall(
  toolCallId: string,
  item: Extract<ReplayItem, { kind: "tool" }>,
  cwd: string,
): acp.SessionUpdate {
  const { title, locations } = describeToolCall(item.name, item.args, cwd);
  const output =
    item.output.length > REPLAYED_OUTPUT_CHARS
      ? `${item.output.slice(0, REPLAYED_OUTPUT_CHARS)}\n[… output shortened in the replay …]`
      : item.output;
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title,
    kind: toolKindOf(item.name),
    status: item.status,
    rawInput: item.args,
    ...(locations.length ? { locations } : {}),
    ...(output ? { content: [{ type: "content", content: { type: "text", text: output } }] } : {}),
    _meta: { "nova-ai-cli/tool": item.name, "nova-ai-cli/replayed": true },
  };
}

/** The command name when the prompt is exactly one advertised slash command. */
function slashCommandName(prompt: acp.PromptRequest["prompt"]): string | null {
  if (prompt.length !== 1 || prompt[0]!.type !== "text") return null;
  const match = /^\/([a-z][a-z0-9-]*)\s*$/.exec(prompt[0]!.text.trim());
  const name = match?.[1];
  return name && AVAILABLE_COMMANDS.some((command) => command.name === name) ? name : null;
}

async function notifyUsage(
  client: acp.AgentContext,
  sessionId: string,
  used: number,
  size: number,
  estimated = false,
): Promise<void> {
  await client
    .notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used,
        size,
        ...(estimated ? { _meta: { "nova-ai-cli/estimated": true } } : {}),
      },
    })
    .catch(() => {});
}
/** How long closing a session waits for its turn to save its history. */
const SHUTDOWN_GRACE_MS = 2_000;

export class NovaAgent implements AgentRuntime {
  private readonly sessions = new Map<string, Session>();
  clientCapabilities: acp.ClientCapabilities | undefined;
  /** Name and version of the connected client, for diagnostics. */
  clientInfo: acp.Implementation | null = null;
  positionEncoding: acp.PositionEncodingKind = "utf-16";
  readonly models = new ModelService();
  private readonly nes = new NesService(this);
  private readonly queue = new QueueService(this);
  private readonly background = new BackgroundService(this);

  /**
   * Nova speaks ACP protocol version 1 and answers with it whatever the client
   * asked for; per the spec the client then decides whether it can continue.
   */
  initialize(params: acp.InitializeRequest): acp.InitializeResponse {
    this.clientCapabilities = params.clientCapabilities;
    this.clientInfo = params.clientInfo ?? null;
    this.positionEncoding = selectPositionEncoding(
      params.clientCapabilities?.positionEncodings,
    );
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: {
        name: "nova-ai-cli",
        title: "Nova AI",
        version: readPackageVersion() ?? "0.0.0",
      },
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
        _meta: { "nova-ai-cli": novaExtensionsMeta() },
      },
      authMethods: [
        {
          id: AUTH_METHOD_ID,
          name: "Nova API Key",
          description:
            "Opens a local page in your browser to connect your DataLab Rotterdam Nova AI account.",
        },
        {
          type: "env_var",
          id: ENV_AUTH_METHOD_ID,
          name: "Nova API key from the environment",
          description: "Start the agent with NOVA_API_KEY set (and optionally NOVA_MODEL).",
          vars: [
            { name: "NOVA_API_KEY", label: "Nova API key", secret: true },
            { name: "NOVA_MODEL", label: "Default model", secret: false, optional: true },
          ],
          link: "https://platform.nova.datalabrotterdam.nl/dashboard/api-keys",
        },
        {
          type: "terminal",
          id: TERMINAL_AUTH_METHOD_ID,
          name: "Log in in a terminal",
          description: "Runs `nova-ai login --no-browser`: paste your Nova API key (hidden input).",
          args: ["login", "--no-browser"],
        },
      ],
    };
  }

  async newSession(
    params: acp.NewSessionRequest,
    client?: acp.AgentContext,
  ): Promise<acp.NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    const { mcpConnections, mcpFailures, skills } = await this.setupSession(
      sessionId,
      params,
      [],
      null,
    );
    this.announceSession(sessionId, client);
    return {
      sessionId,
      modes: sessionModeState("agent"),
      configOptions: [
        permissionModeOption(this.requireSession(sessionId).policy.mode),
      ],
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
    const memory = loadMemory(params.cwd);
    this.sessions.set(sessionId, {
      pendingPrompt: null,
      activeTurns: new Set(),
      turnQueue: Promise.resolve(),
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
      policy: new PermissionPolicy(params.cwd),
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
      throw sessionNotFound(params.sessionId);
    }

    const { mcpConnections, mcpFailures, skills } = await this.setupSession(
      params.sessionId,
      params,
      stored.messages,
      stored.title,
    );

    // Replay what the user saw: text and tool calls with their final status,
    // never tool results disguised as user messages.
    const replay = replayHistory(stored.messages);
    for (const [index, item] of replay.entries()) {
      const update: acp.SessionUpdate =
        item.kind === "user"
          ? { sessionUpdate: "user_message_chunk", content: { type: "text", text: item.text } }
          : item.kind === "agent"
            ? { sessionUpdate: "agent_message_chunk", content: { type: "text", text: item.text } }
            : replayedToolCall(`replay-${index}`, item, params.cwd);
      await client.notify("session/update", { sessionId: params.sessionId, update });
    }

    this.announceSession(params.sessionId, client);
    return {
      modes: sessionModeState("agent"),
      configOptions: [
        permissionModeOption(this.requireSession(params.sessionId).policy.mode),
      ],
      _meta: sessionStatusMeta(
        params.mcpServers,
        mcpConnections,
        mcpFailures,
        skills,
      ),
    };
  }

  /** Newest first, SESSION_PAGE_SIZE per page; the cursor is opaque to clients. */
  listSessions(params: acp.ListSessionsRequest): acp.ListSessionsResponse {
    const offset = decodeCursor(params.cursor);
    const all = listStoredSessions(params.cwd ?? undefined);
    const page = all.slice(offset, offset + SESSION_PAGE_SIZE).map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt || null,
    }));
    const next = offset + SESSION_PAGE_SIZE;
    return {
      sessions: page,
      ...(next < all.length ? { nextCursor: encodeCursor(next) } : {}),
    };
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
      ?.notify(NOVA_NOTIFICATIONS.sessionRewound, {
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
    // Wait for a running turn first: its final save would otherwise
    // re-create the file right after it was deleted.
    if (session) await this.disposeSession(params.sessionId, session);
    deleteStoredSession(params.sessionId);
    return {};
  }

  async forkSession(
    params: acp.ForkSessionRequest,
    client?: acp.AgentContext,
  ): Promise<acp.ForkSessionResponse> {
    const newSessionId = crypto.randomUUID();
    const forked = forkStoredSession(params.sessionId, newSessionId, {
      cwd: params.cwd,
    });
    if (!forked) {
      throw sessionNotFound(params.sessionId);
    }
    await this.setupSession(
      newSessionId,
      params,
      forked.messages,
      forked.title,
    );
    this.announceSession(newSessionId, client);
    return {
      sessionId: newSessionId,
      modes: sessionModeState("agent"),
      configOptions: await this.configOptions(
        this.requireSession(newSessionId),
      ),
    };
  }

  async resumeSession(
    params: acp.ResumeSessionRequest,
    client?: acp.AgentContext,
  ): Promise<acp.ResumeSessionResponse> {
    const stored = loadStoredSession(params.sessionId);
    if (!stored) {
      throw sessionNotFound(params.sessionId);
    }
    await this.setupSession(
      params.sessionId,
      params,
      stored.messages,
      stored.title,
    );
    this.announceSession(params.sessionId, client);
    return {
      modes: sessionModeState("agent"),
      configOptions: await this.configOptions(
        this.requireSession(params.sessionId),
      ),
    };
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId);
    if (params.configId === PERMISSION_MODE_CONFIG_ID) {
      if (!isPermissionMode(params.value)) {
        throw acp.RequestError.invalidParams(
          params,
          `permission_mode must be one of: ${PERMISSION_MODES.join(", ")}`,
        );
      }
      // Clients choose for this session; the TUI remembers a default itself.
      session.policy.setMode(params.value, false);
      return { configOptions: await this.configOptions(session) };
    }
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
    return { configOptions: await this.configOptions(session) };
  }

  /** Permission mode (always) and model (when the model list can be fetched). */
  private async configOptions(
    session: Session,
  ): Promise<acp.SessionConfigOption[]> {
    return [
      permissionModeOption(session.policy.mode),
      ...(await this.models.buildConfigOptions(session)),
    ];
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
    if (params.methodId === TERMINAL_AUTH_METHOD_ID) {
      // The client ran `nova-ai login --no-browser` for the user; check it worked.
      if (!readCredentials()) {
        throw acp.RequestError.authRequired(
          { methodId: params.methodId },
          "No Nova API key is stored yet; the terminal login did not finish.",
        );
      }
      return {};
    }
    if (params.methodId === ENV_AUTH_METHOD_ID) {
      // The client restarts us with the variables set; nothing to do but check.
      if (!process.env.NOVA_API_KEY?.trim()) {
        throw acp.RequestError.authRequired(
          { methodId: params.methodId },
          "NOVA_API_KEY is not set in the agent's environment.",
        );
      }
      return {};
    }
    if (params.methodId !== AUTH_METHOD_ID) {
      throw acp.RequestError.invalidParams(
        { methodId: params.methodId },
        `Unknown auth method: ${params.methodId}`,
      );
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

    const novaClient = createNovaClient(credentials.apiKey);
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

  /**
   * Turns of one session run one after another, so history and the session
   * file are only ever written by one turn. A new prompt cancels every
   * earlier one (running or still waiting), so the latest request wins; a
   * cancelled waiting prompt answers "cancelled" without starting.
   */
  async prompt(
    params: acp.PromptRequest,
    client: acp.AgentContext,
  ): Promise<acp.PromptResponse> {
    const session = this.requireSession(params.sessionId);
    for (const earlier of session.activeTurns) earlier.abort();
    const abortController = new AbortController();
    session.activeTurns.add(abortController);
    const run = session.turnQueue.then(() =>
      abortController.signal.aborted
        ? { stopReason: "cancelled" as const }
        : this.runPrompt(session, params, client, abortController),
    );
    session.turnQueue = run.then(
      () => {},
      () => {},
    );
    try {
      return await run;
    } finally {
      session.activeTurns.delete(abortController);
    }
  }

  private async runPrompt(
    session: Session,
    params: acp.PromptRequest,
    client: acp.AgentContext,
    abortController: AbortController,
  ): Promise<acp.PromptResponse> {
    if (slashCommandName(params.prompt) === "compact") {
      return this.runCompactCommand(session, params.sessionId, client);
    }
    const credentials = readCredentials();
    if (!credentials) {
      throw acp.RequestError.authRequired();
    }
    await notifyPlanUpdate(client, params.sessionId, []);

    session.pendingPrompt = abortController;

    const novaClient = createNovaClient(credentials.apiKey);
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
    session.memory = loadMemory(session.cwd);
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
    const systemPromptFor = (protocol: ToolProtocol) =>
      [
        buildModeSystemPrompt(session.mode),
        buildSkillsSystemPrompt(session.skills),
        buildMemorySystemPrompt(session.memory),
        protocol === "native"
          ? buildNativeToolsSystemPrompt(tools, session.cwd)
          : buildToolsSystemPrompt(tools, session.cwd),
      ]
        .filter(Boolean)
        .join("\n\n");
    const systemPrompt = systemPromptFor(
      chooseToolProtocol(model, this.models.toolSupport, tools.length > 0),
    );

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
    let reportedUsage = false;
    const emit = async (event: AgentEvent) => {
      if (event.type === "usage") {
        reportedUsage = true;
        await notifyUsage(
          client,
          params.sessionId,
          event.promptTokens + event.completionTokens,
          contextWindow,
        );
        return;
      }
      await emitToAcp(client, params.sessionId, event, session.cwd);
    };
    const authorize = (
      toolCallId: string,
      tool: ToolDefinition,
      args: Record<string, unknown>,
    ) =>
      authorizeToolCall(
        {
          client,
          sessionId: params.sessionId,
          cwd: session.cwd,
          host,
          policy: session.policy,
          signal: abortController.signal,
        },
        toolCallId,
        tool,
        args,
      );
    const requestPermission = async (
      toolCallId: string,
      tool: ToolDefinition,
      args: Record<string, unknown>,
    ) => (await authorize(toolCallId, tool, args)).allowed;

    let turnMessages: ChatMessage[] = [];
    let contextCompacted = false;
    try {
      const result = await runWithToolProtocol({
        model,
        support: this.models.toolSupport,
        hasTools: tools.length > 0,
        run: (toolProtocol) => {
          // Both protocols produce a system prompt whenever there are tools,
          // so only its content changes between attempts.
          if (systemMessageCount) {
            messages[0] = { role: "system", content: systemPromptFor(toolProtocol) };
          }
          return runTurn(messages, abortController.signal, {
            toolProtocol,
            host,
            sessionId: params.sessionId,
            cwd: session.cwd,
            environment: session.environment,
            background,
            tools,
            requestPermission,
            authorize,
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
            ],
            emit,
            novaClient,
            model,
          });
        },
      });
      turnMessages = result.turnMessages;
      return { stopReason: result.stopReason };
    } catch (err) {
      if (abortController.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw toAcpError(err);
    } finally {
      if (session.pendingPrompt === abortController) session.pendingPrompt = null;
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
      await this.announceTurnEnd(params.sessionId, session, client, {
        contextWindow,
        reportedUsage,
      });
    }
  }

  /** `/compact` sent as a prompt (advertised in available_commands_update). */
  private async runCompactCommand(
    session: Session,
    sessionId: string,
    client: acp.AgentContext,
  ): Promise<acp.PromptResponse> {
    let message: string;
    try {
      const result = await this.compactSession({ sessionId, model: session.model ?? undefined });
      message = result.compacted
        ? `Compacted the conversation: summarized ${result.removedMessages} older messages and kept ${result.keptMessages}.`
        : "Nothing to compact yet.";
    } catch (error) {
      if (error instanceof acp.RequestError) throw error;
      message = `Could not compact the conversation: ${error instanceof Error ? error.message : String(error)}`;
    }
    await client
      .notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: message },
        },
      })
      .catch(() => {});
    return { stopReason: "end_turn" };
  }

  /** Title, last activity and (when the server reported none) estimated context use. */
  private async announceTurnEnd(
    sessionId: string,
    session: Session,
    client: acp.AgentContext,
    options: { contextWindow: number; reportedUsage: boolean },
  ): Promise<void> {
    if (!this.sessions.has(sessionId)) return;
    await client
      .notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "session_info_update",
          title: session.title,
          updatedAt: new Date().toISOString(),
        },
      })
      .catch(() => {});
    if (!options.reportedUsage) {
      try {
        const usage = this.contextUsage({ sessionId, contextWindow: options.contextWindow });
        await notifyUsage(client, sessionId, usage.totalTokens, options.contextWindow, true);
      } catch {
        // Informational only; never fails the turn.
      }
    }
  }

  /**
   * After session/new or session/load has been answered: the commands this
   * agent understands, and the model choice once the model list has loaded
   * (fetching it inside the request would slow every session start).
   */
  private announceSession(sessionId: string, client: acp.AgentContext | undefined): void {
    if (!client) return;
    setTimeout(() => {
      void (async () => {
        await client
          .notify("session/update", {
            sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: AVAILABLE_COMMANDS,
            },
          })
          .catch(() => {});
        const session = this.sessions.get(sessionId);
        if (!session) return;
        const options = await this.configOptions(session).catch(() => []);
        if (options.length > 1 && this.sessions.has(sessionId)) {
          await client
            .notify("session/update", {
              sessionId,
              update: { sessionUpdate: "config_option_update", configOptions: options },
            })
            .catch(() => {});
        }
      })();
    }, 0);
  }

  cancel(params: acp.CancelNotification): void {
    const session = this.sessions.get(params.sessionId);
    for (const turn of session?.activeTurns ?? []) turn.abort();
  }

  async closeSession(
    params: acp.CloseSessionRequest,
  ): Promise<acp.CloseSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (session) await this.disposeSession(params.sessionId, session);
    return {};
  }

  /**
   * Cancels the session's turns, lets them finish writing their history
   * (bounded), then closes its MCP connections.
   */
  private async disposeSession(sessionId: string, session: Session): Promise<void> {
    this.sessions.delete(sessionId);
    for (const turn of session.activeTurns) turn.abort();
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      session.turnQueue,
      new Promise((resolve) => {
        grace = setTimeout(resolve, SHUTDOWN_GRACE_MS);
      }),
    ]);
    clearTimeout(grace);
    await closeMcpConnections(session.mcpConnections);
  }

  /** Ends every session: cancels turns and background agents, closes MCP. */
  async shutdown(): Promise<void> {
    this.background.backgroundJobs.abortAll();
    await Promise.all(
      [...this.sessions].map(([id, session]) => this.disposeSession(id, session)),
    );
  }

  requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw sessionNotFound(sessionId);
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

