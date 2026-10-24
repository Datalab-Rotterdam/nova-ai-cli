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
import { AUTOPILOT_MAX_TOOL_ROUNDS, isInteractionMode } from "../core/interaction-modes.js";
import {
  closeMcpConnections,
  connectMcpServers,
  listMcpTools,
  mcpToolPrefix,
  type McpConnection,
  type McpConnectionFailure,
} from "../core/mcp.js";
import { FileOAuthProvider, oauthConfigOf } from "../core/mcp-oauth.js";
import { buildMemorySystemPrompt, sessionMemory } from "../core/memory.js";
import { installSkills } from "@datalabrotterdam/nova-ai-skills";
import { findAgentFile, isAutopilot } from "../core/agent-files.js";
import { expandCommand, listCommandFiles } from "../core/command-files.js";
import { isWorkspaceTrusted, novaHomeRoot, setWorkspaceTrusted } from "../core/nova-home.js";
import { readWorkspaceMcpConfiguration, workspaceNeedsTrust } from "../core/workspace-mcp.js";
import { MAX_STOP_HOOK_ROUNDS, runHooks } from "../core/hooks.js";
import type { ToolHooks } from "../core/tool-batch.js";
import {
  applySessionSettings,
  sessionSettingsView,
  settingsFromMeta,
} from "../core/agent/session-settings.js";
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
  disabledSkillNames,
  discoverEnabledSkills,
  discoverSkills,
  setSkillEnabled,
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
import { ModelService, THOUGHT_LEVEL_CONFIG_ID } from "./model-service.js";
import { NesService } from "./nes-service.js";
import { selectPositionEncoding } from "./nes.js";
import {
  contentBlocksToNovaContent,
  contentBlocksToText,
  getPromptEffort,
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

export type SkillState = Pick<SkillDefinition, "name" | "description" | "source" | "path" | "bundledBy"> & {
  enabled: boolean;
};

let skillsInstall: Promise<string[]> | undefined;

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
/** The agent's own commands, then the user's command files (a built-in wins a name clash). */
function availableCommands(cwd: string): acp.AvailableCommand[] {
  const builtIn = new Set(AVAILABLE_COMMANDS.map((command) => command.name));
  return [
    ...AVAILABLE_COMMANDS,
    ...listCommandFiles(cwd)
      .filter((command) => !builtIn.has(command.name))
      .map(({ name, description, argumentHint }) => ({
        name,
        description,
        ...(argumentHint ? { input: { hint: argumentHint } } : {}),
      })),
  ];
}

/**
 * A prompt that starts with `/<name> [arguments]` for one of the user's
 * command files becomes the file's expanded text (other content blocks are
 * kept), with the file's `model` for this answer only.
 */
function expandCommandFile(cwd: string, params: acp.PromptRequest): acp.PromptRequest {
  const [first, ...rest] = params.prompt;
  if (first?.type !== "text") return params;
  const match = /^\/([a-z0-9][\w:-]*)(?:\s+([\s\S]*))?$/.exec(first.text.trim());
  const command = match && !AVAILABLE_COMMANDS.some((builtIn) => builtIn.name === match[1])
    ? listCommandFiles(cwd).find((file) => file.name === match[1])
    : undefined;
  if (!command) return params;
  return {
    ...params,
    prompt: [{ type: "text", text: expandCommand(command, match![2]?.trim() ?? "") }, ...rest],
    ...(command.model ? { _meta: { ...params._meta, "nova-ai-cli/model": command.model } } : {}),
  };
}

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
    // The skills every Nova app ships (Word, Excel, PowerPoint, PDF), in the
    // background: a current copy is left alone, so later starts only compare.
    // ponytail: two apps updating at the same moment can race on a folder; the next start repairs it.
    skillsInstall ??= installSkills(novaHomeRoot()).catch(() => []);
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
    const { mcpServers, mcpConnections, mcpFailures, skills } = await this.setupSession(
      sessionId,
      params,
      [],
      null,
    );
    this.announceSession(sessionId, client);
    return {
      sessionId,
      modes: sessionModeState("agent", params.cwd),
      configOptions: [
        permissionModeOption(this.requireSession(sessionId).policy.mode),
      ],
      _meta: sessionStatusMeta(
        mcpServers,
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
    params: { cwd: string; mcpServers?: acp.McpServer[]; _meta?: Record<string, unknown> | null },
    history: ChatMessage[],
    title: string | null,
  ): Promise<{
    mcpServers: acp.McpServer[];
    mcpConnections: McpConnection[];
    mcpFailures: McpConnectionFailure[];
    skills: SkillDefinition[];
  }> {
    // The workspace's own servers (.mcp.json, .nova-ai/settings.json; trusted
    // workspaces only) plus the client's, which win by name. A client that
    // configures MCP itself opts out with `nova-ai-cli/workspaceMcp: false`.
    const workspaceMcp =
      params._meta?.["nova-ai-cli/workspaceMcp"] === false
        ? { servers: [], failures: [] }
        : readWorkspaceMcpConfiguration(params.cwd);
    const mcpServers = [
      ...new Map(
        [...workspaceMcp.servers, ...(params.mcpServers ?? [])].map((server) => [server.name, server]),
      ).values(),
    ];
    const connectedMcp = await connectMcpServers(mcpServers);
    const loadedMcp = await listMcpTools(connectedMcp.connections);
    const mcpConnections = loadedMcp.connections;
    const mcpFailures = [...workspaceMcp.failures, ...connectedMcp.failures, ...loadedMcp.failures];
    const mcpTools = loadedMcp.tools;
    const environment = await detectToolEnvironment(
      params.cwd,
      this.clientCapabilities,
    );
    const skills = discoverEnabledSkills(params.cwd);
    const settings = settingsFromMeta(params._meta);
    const memory = sessionMemory(params.cwd, settings.memory);
    this.sessions.set(sessionId, {
      pendingPrompt: null,
      activeTurns: new Set(),
      turnQueue: Promise.resolve(),
      promptQueue: new PromptQueue(),
      cwd: params.cwd,
      history,
      pendingBackgroundHandoffs: [],
      title,
      mcpServers,
      mcpConnections,
      mcpTools,
      mcpFailures,
      environment,
      skills,
      memory,
      mode: "agent",
      policy: new PermissionPolicy(params.cwd),
      model: null,
      effort: null,
      settings,
    });
    return { mcpServers, mcpConnections, mcpFailures, skills };
  }

  async loadSession(
    params: acp.LoadSessionRequest,
    client: acp.AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    const stored = loadStoredSession(params.sessionId);
    if (!stored) {
      throw sessionNotFound(params.sessionId);
    }

    const { mcpServers, mcpConnections, mcpFailures, skills } = await this.setupSession(
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
      modes: sessionModeState("agent", params.cwd),
      configOptions: [
        permissionModeOption(this.requireSession(params.sessionId).policy.mode),
      ],
      _meta: sessionStatusMeta(
        mcpServers,
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
    if (!isInteractionMode(params.modeId) && !findAgentFile(session.cwd, params.modeId)) {
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
    const { mcpServers, mcpConnections, mcpFailures, skills } = await this.setupSession(
      newSessionId,
      params,
      forked.messages,
      forked.title,
    );
    this.announceSession(newSessionId, client);
    return {
      sessionId: newSessionId,
      modes: sessionModeState("agent", params.cwd),
      configOptions: await this.configOptions(
        this.requireSession(newSessionId),
      ),
      _meta: sessionStatusMeta(mcpServers, mcpConnections, mcpFailures, skills),
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
    const { mcpServers, mcpConnections, mcpFailures, skills } = await this.setupSession(
      params.sessionId,
      params,
      stored.messages,
      stored.title,
    );
    this.announceSession(params.sessionId, client);
    return {
      modes: sessionModeState("agent", params.cwd),
      configOptions: await this.configOptions(
        this.requireSession(params.sessionId),
      ),
      _meta: sessionStatusMeta(mcpServers, mcpConnections, mcpFailures, skills),
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
    if (params.configId === THOUGHT_LEVEL_CONFIG_ID) {
      if (typeof params.value !== "string" || !params.value) {
        throw acp.RequestError.invalidParams(params, "thought_level requires a level id");
      }
      // Kept across model switches; a model that lacks the level uses its default.
      session.effort = params.value;
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

  /** Permission mode (always), model and thinking level (when the model list can be fetched). */
  private async configOptions(
    session: Session,
  ): Promise<acp.SessionConfigOption[]> {
    return [
      permissionModeOption(session.policy.mode),
      ...(await this.models.buildConfigOptions(session)),
    ];
  }

  /**
   * `_nova/mcp/login`: signs in to an HTTP/SSE server with OAuth. The page to
   * open arrives as `_nova/mcp/auth_url`; the request ends when the browser
   * comes back (or after 5 minutes), and the server is then reconnected.
   * Returns the session's MCP and skill status, as on session/new.
   */
  async mcpLogin(
    params: { sessionId: string; serverName: string },
    client: acp.AgentContext,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const session = this.requireSession(params.sessionId);
    const server = this.httpMcpServer(session, params.serverName);
    const provider = new FileOAuthProvider(server.name, server.url, oauthConfigOf(server));
    await provider.authorize(
      server.url,
      async (url) => {
        await client.notify(NOVA_NOTIFICATIONS.mcpAuthUrl, {
          sessionId: params.sessionId,
          serverName: server.name,
          url: url.toString(),
        });
      },
      signal,
    );
    return this.reconnectMcpServer(params.sessionId, session, server);
  }

  /** `_nova/mcp/logout`: forgets the server's tokens and reconnects it (now signed out). */
  async mcpLogout(params: { sessionId: string; serverName: string }): Promise<Record<string, unknown>> {
    const session = this.requireSession(params.sessionId);
    const server = this.httpMcpServer(session, params.serverName);
    new FileOAuthProvider(server.name, server.url, oauthConfigOf(server)).forget();
    return this.reconnectMcpServer(params.sessionId, session, server);
  }

  private httpMcpServer(session: Session, name: string): Extract<acp.McpServer, { url: string }> {
    const server = session.mcpServers.find((candidate) => candidate.name === name);
    if (!server || !("url" in server)) {
      throw acp.RequestError.invalidParams({ serverName: name }, `No HTTP or SSE MCP server named "${name}" in this session.`);
    }
    return server;
  }

  /** Replaces one server's connection, tools and failures in the session. */
  private async reconnectMcpServer(
    sessionId: string,
    session: Session,
    server: acp.McpServer,
  ): Promise<Record<string, unknown>> {
    const ours = (name: string) => name === server.name;
    await closeMcpConnections(session.mcpConnections.filter((c) => ours(c.serverName)));
    const connected = await connectMcpServers([server]);
    const loaded = await listMcpTools(connected.connections);
    if (this.sessions.get(sessionId) !== session) {
      // Closed meanwhile: nothing would close these.
      await closeMcpConnections(loaded.connections);
      throw sessionNotFound(sessionId);
    }
    const prefix = mcpToolPrefix(server.name);
    session.mcpConnections = [...session.mcpConnections.filter((c) => !ours(c.serverName)), ...loaded.connections];
    session.mcpTools = [...session.mcpTools.filter((tool) => !tool.name.startsWith(prefix)), ...loaded.tools];
    session.mcpFailures = [
      ...session.mcpFailures.filter((failure) => !ours(failure.serverName)),
      ...connected.failures,
      ...loaded.failures,
    ];
    return sessionStatusMeta(session.mcpServers, session.mcpConnections, session.mcpFailures, session.skills);
  }

  /**
   * `_nova/workspace/trust`: trusting a workspace lets its allow rules apply
   * and its MCP servers start (from the next session); without `trusted` it
   * only reports the state. `needsTrust`: untrusted and asking for either.
   */
  workspaceTrust(params: { cwd: string; trusted?: boolean }): {
    trusted: boolean;
    needsTrust: boolean;
  } {
    if (params.trusted !== undefined) setWorkspaceTrusted(params.cwd, params.trusted);
    return { trusted: isWorkspaceTrusted(params.cwd), needsTrust: workspaceNeedsTrust(params.cwd) };
  }

  /** `_nova/skills/list`: every skill discovered for `cwd`, switched-off ones included. */
  listSkills(params: { cwd: string }): { skills: SkillState[] } {
    const disabled = disabledSkillNames(params.cwd);
    return {
      skills: discoverSkills(params.cwd).map(({ name, description, source, path, bundledBy }) => ({
        name,
        description,
        source,
        path,
        ...(bundledBy ? { bundledBy } : {}),
        enabled: !disabled.has(name),
      })),
    };
  }

  /**
   * `_nova/skills/set_enabled`: switches a skill in this project's private
   * settings or (`global`) the user's; sessions pick it up from their next turn.
   */
  setSkillEnabled(params: {
    cwd: string;
    name: string;
    enabled: boolean;
    scope: "project" | "global";
  }): { skills: SkillState[] } {
    if (!discoverSkills(params.cwd).some((skill) => skill.name === params.name)) {
      throw acp.RequestError.invalidParams({ name: params.name }, `No skill named "${params.name}".`);
    }
    setSkillEnabled(params.cwd, params.scope, params.name, params.enabled);
    return this.listSkills(params);
  }

  listModels(params: { preferred?: string }) {
    return this.models.listModels(params.preferred);
  }

  /**
   * `_nova/session/context_usage`: without a `contextWindow` the agent looks
   * up the window of `model` (else the session's or the default model).
   */
  async sessionContextUsage(params: {
    sessionId: string;
    contextWindow?: number | null;
    model?: string;
    mode?: string;
  }): Promise<ContextUsage> {
    const session = this.requireSession(params.sessionId);
    let contextWindow = params.contextWindow ?? null;
    const credentials = contextWindow === null ? readCredentials() : null;
    if (credentials) {
      const model =
        params.model ?? session.model ?? (await this.models.defaultModel(credentials));
      if (model) {
        contextWindow = await this.models.resolveContextWindow(
          createNovaClient(credentials.apiKey),
          model,
        );
      }
    }
    return this.contextUsage({ ...params, contextWindow });
  }

  contextUsage(params: {
    sessionId: string;
    contextWindow?: number | null;
    mode?: string;
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
      systemPrompt: buildModeSystemPrompt(mode, session.cwd),
      skillsPrompt: buildSkillsSystemPrompt(session.skills),
      memoryPrompt: buildMemorySystemPrompt(session.memory, session.settings.memory),
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

  /**
   * Changes a session's settings; keys left out keep their value. Takes effect
   * from the next turn. Answers with the settings now in force.
   */
  setSessionSettings(params: { sessionId: string; settings: Record<string, unknown> }): {
    settings: ReturnType<typeof sessionSettingsView>;
  } {
    const session = this.requireSession(params.sessionId);
    session.settings = applySessionSettings(session.settings, params.settings);
    return { settings: sessionSettingsView(session.settings) };
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
      params.model ?? session.model ?? (await this.models.defaultModel(credentials));
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
    params = expandCommandFile(session.cwd, params);
    // Hooks may block the message or add context; SessionStart only before a chat's first message.
    const hookOptions = { cwd: session.cwd, sessionId: params.sessionId, signal: abortController.signal };
    const notice = (text: string) =>
      emitToAcp(client, params.sessionId, { type: "notice", text }, session.cwd).catch(() => {});
    const started = session.history.length
      ? undefined
      : await runHooks("SessionStart", { source: "startup" }, hookOptions);
    const submitted = await runHooks("UserPromptSubmit", { prompt: contentBlocksToText(params.prompt) }, hookOptions);
    for (const warning of [...(started?.warnings ?? []), ...submitted.warnings]) await notice(warning);
    if (abortController.signal.aborted) return { stopReason: "cancelled" };
    if (submitted.block) {
      await client
        .notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `A hook blocked this message: ${submitted.block}` },
          },
        })
        .catch(() => {});
      return { stopReason: "end_turn" };
    }
    const hookContext = [started?.context, submitted.context].filter(Boolean).join("\n");
    const hookMessages: ChatMessage[] = hookContext
      ? [{ role: "user", content: `Context from the user's hooks:\n${hookContext}` }]
      : [];
    const toolHooks: ToolHooks = {
      before: (tool, args) => runHooks("PreToolUse", { tool_name: tool.name, tool_input: args }, hookOptions),
      after: (tool, args, response) =>
        runHooks("PostToolUse", { tool_name: tool.name, tool_input: args, tool_response: response }, hookOptions),
    };

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
      (await this.models.defaultModel(credentials));
    if (!model) {
      throw new Error(
        "No Nova model configured. Re-run authentication or set NOVA_MODEL.",
      );
    }
    await this.models.assertImageInputSupported(novaClient, model, params.prompt);
    const contextWindow = await this.models.resolveContextWindow(novaClient, model);
    const reasoningEffort = await this.models.effortFor(
      model,
      getPromptEffort(params) ?? session.effort,
    );

    session.environment = await detectToolEnvironment(
      session.cwd,
      this.clientCapabilities,
    );
    session.skills = discoverEnabledSkills(session.cwd);
    session.memory = sessionMemory(session.cwd, session.settings.memory);
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
        buildModeSystemPrompt(session.mode, session.cwd),
        buildSkillsSystemPrompt(session.skills, contentBlocksToText(params.prompt)),
        buildMemorySystemPrompt(session.memory, session.settings.memory),
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
    session.history.push(...backgroundHandoffs, userMessage, ...hookMessages);

    const messages: ChatMessage[] = [
      ...(systemPrompt
        ? [{ role: "system" as const, content: systemPrompt }]
        : []),
      ...session.history,
    ];
    const systemMessageCount = systemPrompt ? 1 : 0;

    const host = new AcpToolHost(client, params.sessionId, {
      defaultTimeoutMs: session.settings.commandTimeoutMs ?? undefined,
    });
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
      hookAllowed?: boolean,
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
        hookAllowed,
      );
    const requestPermission = async (
      toolCallId: string,
      tool: ToolDefinition,
      args: Record<string, unknown>,
    ) => (await authorize(toolCallId, tool, args)).allowed;

    let turnMessages: ChatMessage[] = [];
    let contextCompacted = false;
    try {
      const runOnce = () => runWithToolProtocol({
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
            hooks: toolHooks,
            maxToolRounds: isAutopilot(session.cwd, session.mode) ? AUTOPILOT_MAX_TOOL_ROUNDS : session.settings.maxToolRounds ?? undefined,
            compactThreshold: session.settings.compactThreshold ?? undefined,
            compactContext: !session.settings.autoCompact ? undefined : async (currentMessages, error) => {
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
            reasoningEffort,
          });
        },
      });
      let result = await runOnce();
      turnMessages = [...result.turnMessages];
      // A Stop hook can send the agent back to work (until the tests pass, say), a few times at most.
      for (
        let round = 0;
        round < MAX_STOP_HOOK_ROUNDS && result.stopReason === "end_turn" && !abortController.signal.aborted;
        round++
      ) {
        const stop = await runHooks("Stop", { stop_hook_active: round > 0 }, hookOptions);
        for (const warning of stop.warnings) await notice(warning);
        if (!stop.block || abortController.signal.aborted) break;
        await notice(`A Stop hook asked Nova to continue: ${stop.block}`);
        const nudge: ChatMessage = {
          role: "user",
          content: `A Stop hook did not let you finish yet:\n${stop.block}\nContinue the task.`,
        };
        messages.push(nudge);
        turnMessages.push(nudge);
        result = await runOnce();
        turnMessages.push(...result.turnMessages);
      }
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
          [...backgroundHandoffs, userMessage, ...hookMessages, ...turnMessages],
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

  /** The slash commands this session understands (read again after every turn, so new files show up). */
  private async announceCommands(sessionId: string, session: Session, client: acp.AgentContext): Promise<void> {
    await client
      .notify("session/update", {
        sessionId,
        update: { sessionUpdate: "available_commands_update", availableCommands: availableCommands(session.cwd) },
      })
      .catch(() => {});
  }

  /** Title, last activity and (when the server reported none) estimated context use. */
  private async announceTurnEnd(
    sessionId: string,
    session: Session,
    client: acp.AgentContext,
    options: { contextWindow: number; reportedUsage: boolean },
  ): Promise<void> {
    if (!this.sessions.has(sessionId)) return;
    // ponytail: sent after every turn, not only when a file changed; diff it if clients mind.
    await this.announceCommands(sessionId, session, client);
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
        const session = this.sessions.get(sessionId);
        if (!session) return;
        await this.announceCommands(sessionId, session, client);
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

