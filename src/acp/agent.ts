import * as acp from "@agentclientprotocol/sdk";
import { NovaAI, NovaAIError, type ChatMessage } from "@datalabrotterdam/nova-sdk";
import type { AgentEvent } from "../core/agent-events.js";
import { runTurn } from "../core/run-turn.js";
import { AcpToolHost } from "./acp-tool-host.js";
import { runBrowserAuth } from "./auth-server.js";
import { readCredentials } from "./credentials.js";
import { closeMcpConnections, connectMcpServers, listMcpTools, type McpConnection } from "./mcp.js";
import { detectToolEnvironment, type ToolEnvironment } from "./tools/environment.js";
import { appendSessionTurn, deriveTitle, listStoredSessions, loadStoredSession } from "./sessions.js";
import { availableTools, buildToolsSystemPrompt } from "./tools/index.js";
import type { ToolDefinition } from "./tools/types.js";
import { BackgroundJobManager, type BackgroundJobSummary, summarize } from "./background.js";
import type { BackgroundToolApi, JobIdParams, ListParams, OutputResponse, StartPromptParams, StartTerminalParams } from "./background.js";

const AUTH_METHOD_ID = "nova-api-key";

type Session = {
  pendingPrompt: AbortController | null;
  cwd: string;
  history: ChatMessage[];
  title: string | null;
  mcpConnections: McpConnection[];
  mcpTools: ToolDefinition[];
  environment: ToolEnvironment;
};

export class NovaAgent {
  private readonly sessions = new Map<string, Session>();
  private readonly backgroundJobs = new BackgroundJobManager();
  private clientCapabilities: acp.ClientCapabilities | undefined;

  initialize(params: acp.InitializeRequest): acp.InitializeResponse {
    this.clientCapabilities = params.clientCapabilities;
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          // Image/audio content isn't forwarded to the model; only text and
          // embedded text resources are supported.
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        sessionCapabilities: {
          list: {},
          close: {},
        },
      },
      authMethods: [
        {
          id: AUTH_METHOD_ID,
          name: "Nova API Key",
          description: "Opens a local page in your browser to connect your DataLab Rotterdam Nova AI account.",
        },
      ],
    };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    const mcpConnections = await connectMcpServers(params.mcpServers);
    const mcpTools = await listMcpTools(mcpConnections);
    const environment = await detectToolEnvironment(params.cwd, this.clientCapabilities);
    this.sessions.set(sessionId, {
      pendingPrompt: null,
      cwd: params.cwd,
      history: [],
      title: null,
      mcpConnections,
      mcpTools,
      environment,
    });
    return { sessionId };
  }

  async loadSession(params: acp.LoadSessionRequest, client: acp.AgentContext): Promise<acp.LoadSessionResponse> {
    const stored = loadStoredSession(params.sessionId);
    if (!stored) {
      throw acp.RequestError.internalError(undefined, `Session ${params.sessionId} not found`);
    }

    const mcpConnections = await connectMcpServers(params.mcpServers);
    const mcpTools = await listMcpTools(mcpConnections);
    const environment = await detectToolEnvironment(params.cwd, this.clientCapabilities);
    this.sessions.set(params.sessionId, {
      pendingPrompt: null,
      cwd: params.cwd,
      history: stored.messages,
      title: stored.title,
      mcpConnections,
      mcpTools,
      environment,
    });

    for (const message of stored.messages) {
      if (typeof message.content !== "string" || !message.content) continue;
      if (message.role === "user") {
        await client.notify("session/update", {
          sessionId: params.sessionId,
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: message.content } },
        });
      } else if (message.role === "assistant") {
        await client.notify("session/update", {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: message.content } },
        });
      }
    }

    return {};
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

  async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    if (params.methodId !== AUTH_METHOD_ID) {
      throw new Error(`Unknown auth method: ${params.methodId}`);
    }
    await runBrowserAuth();
    return {};
  }

  async prompt(params: acp.PromptRequest, client: acp.AgentContext): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    const credentials = readCredentials();
    if (!credentials) {
      throw acp.RequestError.authRequired();
    }

    session.pendingPrompt?.abort();
    const abortController = new AbortController();
    session.pendingPrompt = abortController;

    const novaClient = new NovaAI({ apiKey: credentials.apiKey });
    const model = getPromptModel(params) ?? credentials.defaultModel ?? process.env.NOVA_MODEL;
    if (!model) {
      throw new Error(
        "No Nova model configured. Re-run authentication or set NOVA_MODEL.",
      );
    }

    session.environment = await detectToolEnvironment(session.cwd, this.clientCapabilities);
    const background = this.createBackgroundToolApi(params.sessionId, client);
    const tools = [...availableTools(this.clientCapabilities, session.environment, { background: true }), ...session.mcpTools];
    const systemPrompt = [buildModeSystemPrompt(getPromptMode(params)), buildToolsSystemPrompt(tools, session.cwd)]
      .filter(Boolean)
      .join("\n\n");

    const userMessage: ChatMessage = { role: "user", content: contentBlocksToText(params.prompt) };
    session.history.push(userMessage);

    const messages: ChatMessage[] = [
      ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
      ...session.history,
    ];

    const host = new AcpToolHost(client, params.sessionId);
    const emit = (event: AgentEvent) => emitToAcp(client, params.sessionId, event);
    const requestPermission = (toolCallId: string, tool: ToolDefinition, args: Record<string, unknown>) =>
      requestAcpPermission(client, params.sessionId, abortController.signal, toolCallId, tool, args);

    let turnMessages: ChatMessage[] = [];
    try {
      const result = await runTurn(messages, abortController.signal, {
        host,
        sessionId: params.sessionId,
        cwd: session.cwd,
        environment: session.environment,
        background,
        tools,
        requestPermission,
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
        throw new Error(`Nova AI request failed (status ${err.status}, requestId ${err.requestId}): ${err.message}`);
      }
      throw err;
    } finally {
      session.pendingPrompt = null;
      session.history.push(...turnMessages);
      session.title ??= deriveTitle(session.history);
      appendSessionTurn(params.sessionId, { cwd: session.cwd, title: session.title }, [userMessage, ...turnMessages]);
    }
  }

  async startBackgroundTerminal(params: StartTerminalParams, client: acp.AgentContext): Promise<{ job: BackgroundJobSummary }> {
    const session = this.requireSession(params.sessionId);
    if (!this.clientCapabilities?.terminal) {
      throw new Error("background/start_terminal requires ACP terminal client capability.");
    }

    const created = await client.request(acp.methods.client.terminal.create, {
      sessionId: params.sessionId,
      command: params.command,
    });
    const job = this.backgroundJobs.createTerminalJob({
      sessionId: params.sessionId,
      command: params.command,
      title: params.title ?? params.command,
      terminalId: created.terminalId,
    });

    await emitBackgroundUpdate(client, "started", summarize(job));
    void this.watchTerminalJob(client, job.jobId, session.cwd);
    return { job: summarize(job) };
  }

  createBackgroundToolApi(sessionId: string, client: acp.AgentContext): BackgroundToolApi {
    return {
      startCommand: async (command, title) => {
        const response = await this.startBackgroundTerminal({ sessionId, command, title }, client);
        return response.job;
      },
      startAgent: async (prompt, title) => {
        const response = await this.startBackgroundPrompt({ sessionId, prompt: [{ type: "text", text: prompt }], title }, client);
        return response.job;
      },
      list: () => this.backgroundJobs.list(sessionId),
      output: (jobId) => this.backgroundOutput({ jobId }, client),
      kill: async (jobId) => {
        const response = await this.killBackgroundJob({ jobId }, client);
        return response.job;
      },
      release: async (jobId) => {
        const response = await this.releaseBackgroundJob({ jobId }, client);
        return response.job;
      },
    };
  }

  async startBackgroundPrompt(params: StartPromptParams, client: acp.AgentContext): Promise<{ job: BackgroundJobSummary }> {
    const session = this.requireSession(params.sessionId);
    const credentials = readCredentials();
    if (!credentials) {
      throw acp.RequestError.authRequired();
    }

    const model = credentials.defaultModel ?? process.env.NOVA_MODEL;
    if (!model) {
      throw new Error("No Nova model configured. Re-run authentication or set NOVA_MODEL.");
    }

    const abortController = new AbortController();
    const job = this.backgroundJobs.createPromptJob({
      sessionId: params.sessionId,
      title: params.title ?? deriveTitle([{ role: "user", content: contentBlocksToText(params.prompt) }]) ?? "Background prompt",
      abortController,
    });

    await emitBackgroundUpdate(client, "started", summarize(job));
    void this.runBackgroundPrompt(job.jobId, params, client, abortController, credentials.apiKey, model, session).catch(
      async (err) => {
        const current = this.backgroundJobs.get(job.jobId);
        if (!current || current.status !== "running") return;
        const summary = this.backgroundJobs.finish(job.jobId, "failed", {
          error: err instanceof Error ? err.message : "Background prompt failed.",
        });
        await emitBackgroundUpdate(client, "failed", summary).catch(() => {});
      },
    );

    return { job: summarize(job) };
  }

  listBackgroundJobs(params: ListParams): { jobs: BackgroundJobSummary[] } {
    return { jobs: this.backgroundJobs.list(params.sessionId) };
  }

  async backgroundOutput(params: JobIdParams, client: acp.AgentContext): Promise<OutputResponse> {
    const job = this.backgroundJobs.get(params.jobId);
    if (!job) throw new Error(`Background job ${params.jobId} not found`);
    if (job.kind === "prompt") {
      return { job: summarize(job), output: job.output, truncated: false, outputPath: job.outputPath };
    }

    const output = await client.request(acp.methods.client.terminal.output, {
      sessionId: job.sessionId,
      terminalId: job.terminalId,
    });
    this.backgroundJobs.recordTerminalOutput(job.jobId, output.output);
    if (output.exitStatus && job.status === "running") {
      this.backgroundJobs.finish(job.jobId, output.exitStatus.exitCode === 0 ? "completed" : "failed", {
        exitCode: output.exitStatus.exitCode ?? null,
        signal: output.exitStatus.signal ?? null,
      });
    }
    return { job: summarize(job), output: output.output, truncated: output.truncated, outputPath: job.outputPath };
  }

  async killBackgroundJob(params: JobIdParams, client: acp.AgentContext): Promise<{ job: BackgroundJobSummary }> {
    const job = this.backgroundJobs.get(params.jobId);
    if (!job) throw new Error(`Background job ${params.jobId} not found`);

    if (job.kind === "prompt") {
      job.abortController.abort();
    } else if (job.status === "running") {
      await client.request(acp.methods.client.terminal.kill, {
        sessionId: job.sessionId,
        terminalId: job.terminalId,
      });
    }

    const summary = this.backgroundJobs.finish(params.jobId, "killed", { signal: "killed" });
    await emitBackgroundUpdate(client, "killed", summary);
    return { job: summary };
  }

  async releaseBackgroundJob(params: JobIdParams, client: acp.AgentContext): Promise<{ job: BackgroundJobSummary }> {
    const job = this.backgroundJobs.get(params.jobId);
    if (!job) throw new Error(`Background job ${params.jobId} not found`);

    if (job.kind === "terminal") {
      await client.request(acp.methods.client.terminal.release, {
        sessionId: job.sessionId,
        terminalId: job.terminalId,
      });
    } else if (job.status === "running") {
      job.abortController.abort();
    }

    const summary = this.backgroundJobs.release(params.jobId);
    await emitBackgroundUpdate(client, "released", summary);
    return { job: summary };
  }

  cancel(params: acp.CancelNotification): void {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }

  async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.pendingPrompt?.abort();
      await closeMcpConnections(session.mcpConnections);
      this.sessions.delete(params.sessionId);
    }
    return {};
  }

  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return session;
  }

  private async watchTerminalJob(client: acp.AgentContext, jobId: string, cwd: string): Promise<void> {
    const job = this.backgroundJobs.get(jobId);
    if (!job || job.kind !== "terminal") return;
    try {
      const exit = await client.request(acp.methods.client.terminal.waitForExit, {
        sessionId: job.sessionId,
        terminalId: job.terminalId,
      });
      const current = this.backgroundJobs.get(jobId);
      if (!current || current.status !== "running") return;
      const output = await client.request(acp.methods.client.terminal.output, {
        sessionId: job.sessionId,
        terminalId: job.terminalId,
      });
      this.backgroundJobs.recordTerminalOutput(jobId, output.output);
      const status = exit.exitCode === 0 ? "completed" : "failed";
      const summary = this.backgroundJobs.finish(jobId, status, {
        exitCode: exit.exitCode ?? null,
        signal: exit.signal ?? null,
      });
      await emitBackgroundUpdate(client, status, summary, { cwd });
    } catch (err) {
      const current = this.backgroundJobs.get(jobId);
      if (!current || current.status !== "running") return;
      const summary = this.backgroundJobs.finish(jobId, "failed", {
        error: err instanceof Error ? err.message : "Background terminal failed.",
      });
      await emitBackgroundUpdate(client, "failed", summary, { cwd }).catch(() => {});
    }
  }

  private async runBackgroundPrompt(
    jobId: string,
    params: StartPromptParams,
    client: acp.AgentContext,
    abortController: AbortController,
    apiKey: string,
    model: string,
    session: Session,
  ): Promise<void> {
    session.environment = await detectToolEnvironment(session.cwd, this.clientCapabilities);
    const novaClient = new NovaAI({ apiKey });
    const background = this.createBackgroundToolApi(params.sessionId, client);
    const tools = [...availableTools(this.clientCapabilities, session.environment, { background: true }), ...session.mcpTools];
    const systemPrompt = [buildModeSystemPrompt(getPromptMode(params)), buildToolsSystemPrompt(tools, session.cwd)]
      .filter(Boolean)
      .join("\n\n");
    const userMessage: ChatMessage = { role: "user", content: contentBlocksToText(params.prompt) };
    const messages: ChatMessage[] = [
      ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
      ...session.history,
      userMessage,
    ];
    const host = new AcpToolHost(client, params.sessionId);
    const requestPermission = (toolCallId: string, tool: ToolDefinition, args: Record<string, unknown>) =>
      requestAcpPermission(client, params.sessionId, abortController.signal, toolCallId, tool, args);
    const emit = async (event: AgentEvent) => {
      this.backgroundJobs.recordPromptEvent(jobId, event);
    };

    let turnMessages: ChatMessage[] = [];
    try {
      const result = await runTurn(messages, abortController.signal, {
        host,
        sessionId: params.sessionId,
        cwd: session.cwd,
        environment: session.environment,
        background,
        tools,
        requestPermission,
        emit,
        novaClient,
        model,
      });
      turnMessages = result.turnMessages;
      const status = result.stopReason === "cancelled" ? "killed" : "completed";
      const current = this.backgroundJobs.get(jobId);
      if (!current || current.status !== "running") return;
      const summary = this.backgroundJobs.finish(jobId, status);
      await emitBackgroundUpdate(client, status, summary);
    } finally {
      session.history.push(userMessage, ...turnMessages);
      session.title ??= deriveTitle(session.history);
      appendSessionTurn(params.sessionId, { cwd: session.cwd, title: session.title }, [userMessage, ...turnMessages]);
    }
  }
}

async function emitToAcp(client: acp.AgentContext, sessionId: string, event: AgentEvent): Promise<void> {
  switch (event.type) {
    case "text":
      await client.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } },
      });
      return;
    case "tool_pending":
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: event.toolCallId,
          title: event.name,
          kind: event.mutating ? "execute" : "read",
          status: "pending",
          rawInput: event.args,
        },
      });
      return;
    case "tool_update":
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: event.status,
          content: [{ type: "content", content: { type: "text", text: event.output } }],
          rawOutput: { output: event.output },
        },
      });
      return;
    case "end_turn":
    case "error":
      return;
  }
}

async function emitBackgroundUpdate(
  client: acp.AgentContext,
  event: string,
  job: BackgroundJobSummary,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await client.notify("background/update", { event, job, ...extra });
}

async function requestAcpPermission(
  client: acp.AgentContext,
  sessionId: string,
  signal: AbortSignal,
  toolCallId: string,
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<boolean> {
  const response = await client.request(
    acp.methods.client.session.requestPermission,
    {
      sessionId,
      toolCall: {
        toolCallId,
        title: tool.name,
        kind: "execute",
        status: "pending",
        rawInput: args,
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
    { cancellationSignal: signal },
  );

  return response.outcome.outcome === "selected" && response.outcome.optionId === "allow";
}

function contentBlocksToText(prompt: acp.PromptRequest["prompt"]): string {
  return prompt
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "resource_link") return block.uri;
      if (block.type === "resource" && "text" in block.resource) return block.resource.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function getPromptMode(params: acp.PromptRequest): string | null {
  const mode = params._meta?.["nova-ai-cli/tui-mode"];
  return typeof mode === "string" ? mode : null;
}

function getPromptModel(params: acp.PromptRequest): string | null {
  const model = params._meta?.["nova-ai-cli/model"];
  return typeof model === "string" && model ? model : null;
}

function buildModeSystemPrompt(mode: string | null): string | null {
  switch (mode) {
    case "ask":
      return "You are in ask mode. Answer the user's question directly. Do not call tools, edit files, or run commands.";
    case "plan":
      return "You are in plan mode. Produce a concise implementation plan or technical approach. Do not call tools, edit files, or run commands.";
    default:
      return null;
  }
}
