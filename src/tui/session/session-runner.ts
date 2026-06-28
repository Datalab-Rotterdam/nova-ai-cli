import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { NovaAI, NovaAIError } from "@datalabrotterdam/nova-sdk";
import { NovaAgent } from "../../acp/agent.js";
import type { BackgroundJobKind, BackgroundJobSummary, OutputResponse } from "../../acp/background.js";
import type { StoredCredentials } from "../../acp/credentials.js";
import { writeCredentials } from "../../acp/credentials.js";
import { loadStoredSession } from "../../acp/sessions.js";
import type { Store } from "../state/store.js";
import type { InteractionMode, UIMessage, UIState } from "../state/types.js";
import { TuiAcpClient } from "./tui-acp-client.js";

let nextId = 0;
function uid(): string {
  nextId += 1;
  return `m${nextId}`;
}

export class SessionRunner {
  sessionId: string;
  cwd: string;
  title: string | null = null;
  model: string;
  interactionMode: InteractionMode = "agent";

  private readonly agent = new NovaAgent();
  private readonly acpClient: TuiAcpClient;
  private readonly acpContext: acp.AgentContext;
  private readonly novaClient: NovaAI;
  private readonly knownFiles: Set<string>;
  private sessionReady: Promise<void>;
  private agentSessionLoaded = false;
  private promptActive = false;
  private readonly completedBackgroundAgentJobs = new Set<string>();
  private handoffActive = false;
  private readonly queue: string[] = [];

  constructor(
    private readonly store: Store<UIState>,
    private readonly credentials: StoredCredentials,
    cwd: string,
    knownFiles: string[] = [],
  ) {
    this.knownFiles = new Set(knownFiles);
    this.cwd = cwd;
    this.acpClient = new TuiAcpClient(store, cwd, (event, job) => this.handleBackgroundLifecycle(event, job));
    this.acpContext = this.acpClient.context();
    this.agent.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: this.acpClient.capabilities,
    });
    this.novaClient = new NovaAI({ apiKey: credentials.apiKey });
    const model = credentials.defaultModel ?? process.env.NOVA_MODEL;
    if (!model) throw new Error("No Nova model configured. Re-run authentication or set NOVA_MODEL.");
    this.model = model;
    this.sessionId = crypto.randomUUID();
    this.sessionReady = Promise.resolve();
  }

  resumeFrom(storedSessionId: string): boolean {
    const stored = loadStoredSession(storedSessionId);
    if (!stored) return false;

    this.sessionId = stored.sessionId;
    this.cwd = stored.cwd;
    this.title = stored.title;

    const messages: UIMessage[] = stored.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        id: uid(),
        role: message.role as "user" | "assistant",
        text: typeof message.content === "string" ? message.content : "",
        ...(message.role === "assistant" ? { streaming: false } : {}),
      })) as UIMessage[];

    this.store.setState({ messages, sessionId: this.sessionId, cwd: this.cwd });
    this.agentSessionLoaded = false;
    this.sessionReady = this.agent
      .loadSession(
        { sessionId: stored.sessionId, cwd: stored.cwd, mcpServers: [] },
        silentContext(this.acpContext),
      )
      .then(() => {
        this.agentSessionLoaded = true;
      });
    void this.sessionReady.catch((err) => {
      this.acpClient.appendError(err instanceof Error ? err.message : "Failed to load session.");
    });
    return true;
  }

  cancel(): void {
    this.agent.cancel({ sessionId: this.sessionId });
  }

  setModel(model: string): void {
    this.model = model;
    writeCredentials({ ...this.credentials, defaultModel: model });
  }

  /**
   * Starts a brand-new session: aborts any in-flight prompt, drops the
   * queued messages and server-side conversation history, and gets a fresh
   * sessionId — unlike a transcript-only clear, the model has no memory of
   * what came before.
   */
  async startNewSession(): Promise<void> {
    this.cancel();
    this.queue.length = 0;
    this.title = null;
    this.promptActive = false;
    this.agentSessionLoaded = false;
    this.sessionReady = this.createSession();
    await this.sessionReady;
    this.store.setState({ messages: [], statusLine: null, queuedCount: 0, busy: false });
  }

  async listModels(): Promise<Array<{ id: string; name?: string | null }>> {
    const { data } = await this.novaClient.models.list();
    return data
      .filter((model) => Array.isArray(model.capabilities) && model.capabilities.includes("tools"))
      .map((model) => ({ id: model.id, name: model.name ?? null }));
  }

  async startBackgroundShell(command: string): Promise<BackgroundJobSummary> {
    await this.ensureSession();
    const { job } = await this.agent.startBackgroundTerminal({ sessionId: this.sessionId, command }, this.acpContext);
    return job;
  }

  async startBackgroundAgent(prompt: string): Promise<BackgroundJobSummary> {
    await this.ensureSession();
    const { job } = await this.agent.startBackgroundPrompt(
      { sessionId: this.sessionId, prompt: [{ type: "text", text: prompt }] },
      this.acpContext,
    );
    return job;
  }

  async listBackgroundJobs(kind?: BackgroundJobKind): Promise<BackgroundJobSummary[]> {
    await this.ensureSession();
    const { jobs } = this.agent.listBackgroundJobs({ sessionId: this.sessionId });
    return kind ? jobs.filter((job) => job.kind === kind) : jobs;
  }

  async backgroundOutput(jobId: string): Promise<OutputResponse> {
    await this.ensureSession();
    return this.agent.backgroundOutput({ jobId }, this.acpContext);
  }

  async killBackgroundJob(jobId: string): Promise<BackgroundJobSummary> {
    await this.ensureSession();
    const { job } = await this.agent.killBackgroundJob({ jobId }, this.acpContext);
    return job;
  }

  async releaseBackgroundJob(jobId: string): Promise<BackgroundJobSummary> {
    await this.ensureSession();
    const { job } = await this.agent.releaseBackgroundJob({ jobId }, this.acpContext);
    return job;
  }

  private async handleBackgroundLifecycle(event: string, job: { jobId: string; kind: string; status: string }): Promise<void> {
    if (job.kind !== "prompt" || event !== "completed") return;
    this.completedBackgroundAgentJobs.add(job.jobId);
    await this.maybeHandoffBackgroundAgentOutputs();
  }

  async submit(text: string): Promise<void> {
    if (this.store.getState().busy || this.promptActive) {
      this.queue.push(text);
      this.store.setState({ queuedCount: this.queue.length });
      return;
    }

    this.acpClient.appendUserMessage(text);
    this.acpClient.resetStreaming();
    this.promptActive = true;
    this.store.setState({ busy: true });

    try {
      await this.ensureSession();
      const modelText = await this.injectFileMentions(text);
      const response = await this.agent.prompt(
        {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text: modelText }],
          _meta: { "nova-ai-cli/tui-mode": this.interactionMode, "nova-ai-cli/model": this.model },
        },
        this.acpContext,
      );
      if (response.stopReason === "cancelled") {
        this.store.setState({ statusLine: "Request canceled." });
      }
    } catch (err) {
      const message =
        err instanceof NovaAIError
          ? `Nova AI request failed (status ${err.status}, requestId ${err.requestId}): ${err.message}`
          : err instanceof Error
            ? err.message
            : "Unknown error.";
      this.acpClient.appendError(message);
    } finally {
      this.promptActive = false;
      this.acpClient.resetStreaming();
      this.store.setState({ busy: false });
    }

    const next = this.queue.shift();
    if (next !== undefined) {
      this.store.setState({ queuedCount: this.queue.length });
      await this.submit(next);
    }
  }

  private async createSession(): Promise<void> {
    const { sessionId } = await this.agent.newSession({ cwd: this.cwd, mcpServers: [] });
    this.sessionId = sessionId;
    this.agentSessionLoaded = true;
    this.store.setState({ sessionId });
  }

  private async ensureSession(): Promise<void> {
    await this.sessionReady;
    if (!this.agentSessionLoaded) {
      this.sessionReady = this.createSession();
      await this.sessionReady;
    }
  }

  private async maybeHandoffBackgroundAgentOutputs(): Promise<void> {
    if (this.handoffActive || this.promptActive || this.completedBackgroundAgentJobs.size === 0) return;
    const jobs = this.agent.listBackgroundJobs({ sessionId: this.sessionId }).jobs.filter((job) => job.kind === "prompt");
    if (jobs.some((job) => job.status === "running")) return;

    this.handoffActive = true;
    const jobIds = [...this.completedBackgroundAgentJobs];
    this.completedBackgroundAgentJobs.clear();

    try {
      const outputs = await Promise.all(
        jobIds.map(async (jobId) => {
          const result = await this.agent.backgroundOutput({ jobId }, this.acpContext);
          return `## ${result.job.title}\njobId: ${jobId}\nstatus: ${result.job.status}\noutputPath: ${result.outputPath ?? result.job.outputPath ?? ""}\n\n${result.output}`;
        }),
      );
      await this.submit(
        `Background agent jobs have finished. Use their outputs to continue the main task.\n\n${outputs.join("\n\n---\n\n")}`,
      );
    } finally {
      this.handoffActive = false;
    }
  }

  private async injectFileMentions(text: string): Promise<string> {
    const mentioned = [...new Set([...text.matchAll(/@([^\s]+)/g)].map((match) => match[1]).filter((path) => this.knownFiles.has(path)))];
    if (mentioned.length === 0) return text;

    const blocks = await Promise.all(
      mentioned.map(async (relPath) => {
        try {
          const { content } = await this.acpClient.readTextFile({
            sessionId: this.sessionId,
            path: join(this.cwd, relPath),
          });
          return `\n--- file: ${relPath} ---\n${content}\n---`;
        } catch (err) {
          return `\n[could not read @${relPath}: ${err instanceof Error ? err.message : "unknown error"}]`;
        }
      }),
    );

    return `${text}${blocks.join("")}`;
  }
}

function silentContext(context: acp.AgentContext): acp.AgentContext {
  return {
    request: (method: string, params?: unknown, options?: acp.SendRequestOptions) => context.request(method, params, options),
    notify: async () => {},
  } as unknown as acp.AgentContext;
}
