import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
  NovaAI,
  NovaAIError,
  type ChatMessage,
} from "@datalabrotterdam/nova-sdk";
import { createNovaClient } from "@datalabrotterdam/nova-ai-agent/core/nova-client.js";
import { NovaAgent } from "@datalabrotterdam/nova-ai-agent/acp/agent.js";
import type { CompactionSummary } from "../commands/types.js";
import { startInProcessAgent, type InProcessAgent } from "@datalabrotterdam/nova-ai-agent/client/in-process.js";
import type { NovaAgentClient } from "@datalabrotterdam/nova-ai-agent/client/nova-agent-client.js";
import { replayHistory } from "@datalabrotterdam/nova-ai-agent/core/history.js";
import type {
  BackgroundJobKind,
  BackgroundJobSummary,
  OutputResponse,
} from "@datalabrotterdam/nova-ai-agent/core/background.js";
import type { StoredCredentials } from "@datalabrotterdam/nova-ai-agent/core/credentials.js";
import type { PromptQueueEntryView } from "@datalabrotterdam/nova-ai-agent/core/prompt-queue.js";
import { saveDefaultModel } from "@datalabrotterdam/nova-ai-agent/core/credentials.js";
import {
  savePermissionMode,
  type PermissionMode as AgentPermissionMode,
} from "@datalabrotterdam/nova-ai-agent/core/policy/settings.js";
import { loadStoredSession } from "@datalabrotterdam/nova-ai-agent/core/sessions.js";
import type { SessionCheckpoint } from "@datalabrotterdam/nova-ai-agent/core/sessions.js";
import { discoverSkills } from "@datalabrotterdam/nova-ai-agent/core/skills.js";
import { chatContentToText } from "@datalabrotterdam/nova-ai-agent/core/chat-content.js";
import {
  resolveModelContextWindow,
  type ContextCompactionResult,
} from "@datalabrotterdam/nova-ai-agent/core/context-compaction.js";
import type { ContextUsage } from "@datalabrotterdam/nova-ai-agent/core/context-usage.js";
import {
  chatModels,
  resolveDefaultModel,
  resolveModelSupportsImageInput,
} from "@datalabrotterdam/nova-ai-agent/core/model-capabilities.js";
import { findWorkspaceFileMentions } from "../files/file-mentions.js";
import type { PromptImageAttachment } from "../files/prompt-images.js";
import {
  expandPromptPastes,
  type PromptPasteAttachment,
} from "../files/prompt-pastes.js";
import { readWorkspaceMcpConfiguration } from "../settings/workspace-mcp.js";
import type { Store } from "../state/store.js";
import type {
  InteractionMode,
  PermissionMode,
  ToolCallView,
  UIMessage,
  UIState,
} from "../state/types.js";
import { TuiAcpClient } from "./tui-acp-client.js";

let nextId = 0;
function uid(): string {
  nextId += 1;
  // Resumed history and live ACP updates are created by different producers.
  // Keep their IDs disjoint so a new streamed message can never mutate a
  // restored transcript entry with the same ordinal.
  return `history-${nextId}`;
}

type RestoredToolMetadata = Pick<ToolCallView, "kind" | "mutating">;

const RESTORED_TOOL_METADATA: Record<string, RestoredToolMetadata> = {
  read_file: { kind: "read", mutating: false },
  list_directory: { kind: "search", mutating: false },
  search_text: { kind: "search", mutating: false },
  inspect_environment: { kind: "read", mutating: false },
  load_skill: { kind: "read", mutating: false },
  memory_read: { kind: "read", mutating: false },
  load_memory: { kind: "read", mutating: false },
  list_background_jobs: { kind: "read", mutating: false },
  read_background_output: { kind: "read", mutating: false },
  wait_for_background_jobs: { kind: "think", mutating: false },
  ask_user: { kind: "think", mutating: false },
  update_plan: { kind: "think", mutating: false },
  enter_plan_mode: { kind: "switch_mode", mutating: false },
  write_file: { kind: "edit", mutating: true },
  edit_file: { kind: "edit", mutating: true },
  memory_write: { kind: "edit", mutating: true },
  save_memory: { kind: "edit", mutating: true },
  run_command: { kind: "execute", mutating: true },
  run_package_script: { kind: "execute", mutating: true },
  start_background_command: { kind: "execute", mutating: true },
  start_background_agent: { kind: "think", mutating: true },
  kill_background_job: { kind: "execute", mutating: true },
  release_background_job: { kind: "execute", mutating: true },
};

/** Rebuilds the live transcript shape from the model-facing stored history. */
export function restoreSessionMessages(messages: ChatMessage[]): UIMessage[] {
  return replayHistory(messages).flatMap((item): UIMessage[] => {
    if (item.kind === "user") return [{ id: uid(), role: "user", text: item.text }];
    if (item.kind === "agent") {
      return [{ id: uid(), role: "assistant", text: item.text, streaming: false }];
    }
    if (item.name === "update_plan") return [];
    const metadata = RESTORED_TOOL_METADATA[item.name] ?? {
      // Persisted ACP/MCP calls do not currently retain annotations. Keep
      // unknown calls compact without falsely labelling them as changes.
      kind: "execute",
      mutating: false,
    };
    return [
      {
        id: uid(),
        role: "tool",
        call: {
          toolCallId: uid(),
          name: item.name,
          args: item.args,
          kind: metadata.kind,
          mutating: metadata.mutating,
          status: item.status,
          output: item.output,
          diff: null,
        },
      },
    ];
  });
}

export type McpSessionStatus = {
  configured: Array<{ name: string; transport: string }>;
  connected: string[];
  failures: Array<{ serverName: string; message: string }>;
};

export type SkillSessionStatus = {
  name: string;
  description: string;
  source: "user" | "workspace";
  path: string;
};

type QueuedPromptAttachments = {
  images: PromptImageAttachment[];
  pastes: PromptPasteAttachment[];
};

export type QueuedMessageEntry = Pick<
  PromptQueueEntryView,
  "id" | "text" | "kind"
>;

export class SessionRunner {
  sessionId: string;
  cwd: string;
  title: string | null = null;
  model: string;
  interactionMode: InteractionMode = "agent";

  /** The agent, served in-process over a real ACP connection (tests may stub it). */
  private readonly agent = new NovaAgent();
  private readonly acpClient: TuiAcpClient;
  private readonly connection: InProcessAgent;
  private readonly nova: NovaAgentClient;
  private readonly initialized: Promise<unknown>;
  private readonly novaClient: NovaAI;
  private mcpServers: acp.McpServer[] = [];
  private mcpConfigurationFailures: McpSessionStatus["failures"] = [];
  private mcpStatus: McpSessionStatus = {
    configured: [],
    connected: [],
    failures: [],
  };
  private skills: SkillSessionStatus[];
  private sessionReady: Promise<void>;
  private agentSessionLoaded = false;
  private promptActive = false;
  private readonly completedBackgroundAgentJobs = new Set<string>();
  private handoffActive = false;
  private readonly queuedAttachments = new Map<
    string,
    QueuedPromptAttachments
  >();
  private editingQueuedMessageId: string | null = null;
  private readonly imageSupportByModel = new Map<string, boolean>();
  private contextWindow: number | null = null;
  private contextWindowModel: string | null = null;
  private contextWindowRequest = 0;
  private contextUsageRequest = 0;
  private modelCheck: Promise<void> | null = null;

  constructor(
    private readonly store: Store<UIState>,
    private readonly credentials: StoredCredentials,
    cwd: string,
  ) {
    this.loadMcpConfiguration(cwd);
    this.skills = discoverSkills(cwd).map(
      ({ name, description, source, path }) => ({
        name,
        description,
        source,
        path,
      }),
    );
    this.cwd = cwd;
    this.acpClient = new TuiAcpClient(
      store,
      cwd,
      (event, job) => this.handleBackgroundLifecycle(event, job),
      (mode) =>
        this.applyInteractionMode(mode, `Agent switched to ${mode} mode.`),
    );
    this.connection = startInProcessAgent(() => this.acpClient.asAcpClient(), this.agent);
    this.nova = this.connection.client;
    this.initialized = this.nova.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: this.acpClient.capabilities,
      clientInfo: { name: "nova-ai-cli-tui", version: "1" },
    });
    this.novaClient = createNovaClient(credentials.apiKey);
    const model = credentials.defaultModel ?? process.env.NOVA_MODEL;
    if (!model)
      throw new Error(
        "No Nova model configured. Re-run authentication or set NOVA_MODEL.",
      );
    this.model = model;
    this.sessionId = crypto.randomUUID();
    this.sessionReady = Promise.resolve();
  }

  resumeFrom(storedSessionId: string): boolean {
    const stored = loadStoredSession(storedSessionId);
    if (!stored) return false;

    const previousSessionId = this.agentSessionLoaded ? this.sessionId : null;
    if (previousSessionId) void this.nova.cancel({ sessionId: previousSessionId });
    this.queuedAttachments.clear();
    this.editingQueuedMessageId = null;
    this.sessionId = stored.sessionId;
    this.cwd = stored.cwd;
    this.title = stored.title;
    this.loadMcpConfiguration(stored.cwd);
    this.skills = discoverSkills(stored.cwd).map(
      ({ name, description, source, path }) => ({
        name,
        description,
        source,
        path,
      }),
    );

    const messages = restoreSessionMessages(stored.messages);

    this.store.setState({
      messages,
      plan: [],
      sessionId: this.sessionId,
      cwd: this.cwd,
      queuedCount: 0,
      contextUsage: null,
    });
    this.agentSessionLoaded = false;
    this.sessionReady = this.initialized
      .then(() =>
        previousSessionId
          ? this.nova.closeSession({ sessionId: previousSessionId })
          : {},
      )
      .then(async () => {
        // The transcript was restored above; the agent's replay would repeat it.
        this.acpClient.muteSessionUpdates = true;
        try {
          return await this.nova.loadSession({
            sessionId: stored.sessionId,
            cwd: stored.cwd,
            mcpServers: this.mcpServers,
          });
        } finally {
          this.acpClient.muteSessionUpdates = false;
        }
      })
      .then((response) => {
        this.applyMcpStatus(response._meta);
        this.applySkillStatus(response._meta);
        this.agentSessionLoaded = true;
        this.applyQueue([]);
        void this.nova
          .setSessionMode({ sessionId: this.sessionId, modeId: this.interactionMode })
          .catch(() => {});
        this.applyPermissionMode(this.sessionId);
        void this.updateContextUsage();
        void this.refreshContextUsage().catch(() => {});
      });
    void this.sessionReady.catch((err) => {
      this.acpClient.appendError(
        err instanceof Error ? err.message : "Failed to load session.",
      );
    });
    return true;
  }

  cancel(): void {
    void this.nova.cancel({ sessionId: this.sessionId }).catch(() => {});
  }

  queuedMessages(): string[] {
    return this.promptQueueEntries().map((prompt) => prompt.text);
  }

  queuedMessageEntries(): QueuedMessageEntry[] {
    return this.promptQueueEntries().map(({ id, text, kind }) => ({
      id,
      text,
      kind,
    }));
  }

  /**
   * The editor needs an answer right away: it comes from the local queue
   * mirror, and the agent's response reconciles it (an entry that already
   * started running cannot be edited any more).
   */
  beginQueuedMessageEdit(id: string): boolean {
    if (!this.agentSessionLoaded) return false;
    if (!this.promptQueueEntries().some((entry) => entry.id === id)) return false;
    this.editingQueuedMessageId = id;
    this.syncQueueTranscript();
    this.store.setState({ statusLine: "Editing queued message." });
    void this.nova
      .queueEditBegin({ sessionId: this.sessionId, id })
      .then(({ updated, entries }) => {
        this.applyQueue(entries);
        if (!updated && this.editingQueuedMessageId === id) {
          this.editingQueuedMessageId = null;
          this.syncQueueTranscript("That message was already sent.");
        }
      })
      .catch(() => {});
    return true;
  }

  updateQueuedMessage(id: string, text: string): boolean {
    if (!this.agentSessionLoaded) return false;
    if (!this.promptQueueEntries().some((entry) => entry.id === id)) return false;
    this.applyQueue(
      this.promptQueueEntries().map((entry) => (entry.id === id ? { ...entry, text } : entry)),
    );
    void this.nova
      .queueUpdate({ sessionId: this.sessionId, id, text })
      .then(({ entries }) => this.applyQueue(entries))
      .catch(() => {});
    this.syncQueueTranscript();
    return true;
  }

  finishQueuedMessageEdit(
    id: string,
    text: string,
    images: PromptImageAttachment[] = [],
    pastes: PromptPasteAttachment[] = [],
  ): boolean {
    const entry = this.promptQueueEntries().find((prompt) => prompt.id === id);
    if (!entry) {
      if (this.editingQueuedMessageId === id)
        this.editingQueuedMessageId = null;
      return false;
    }

    const value = text.trim();
    if (!value) {
      this.applyQueue(this.promptQueueEntries().filter((queued) => queued.id !== id));
      void this.nova
        .queueRemove({ sessionId: this.sessionId, id })
        .then(({ entries }) => this.applyQueue(entries))
        .catch(() => {});
      this.queuedAttachments.delete(id);
      if (this.editingQueuedMessageId === id)
        this.editingQueuedMessageId = null;
      this.syncQueueTranscript("Queued message removed.");
      if (!this.store.getState().busy && !this.promptActive)
        void this.runNextQueuedPrompt();
    } else {
      const attachments = this.queuedAttachments.get(id) ?? {
        images: [],
        pastes: [],
      };
      this.queuedAttachments.set(id, {
        images: mergeReferencedImages(attachments.images, images, value),
        pastes: mergeReferencedPastes(attachments.pastes, pastes, value),
      });
      void this.nova
        .queueUpdate({ sessionId: this.sessionId, id, text: value })
        .then(({ entries }) => this.applyQueue(entries))
        .catch(() => {})
        .then(() => this.finalizeQueuedMessageEdit(id, value));
    }
    return true;
  }

  clearQueuedMessages(): number {
    if (!this.agentSessionLoaded) return 0;
    const count = this.promptQueueEntries().length;
    this.applyQueue([]);
    void this.nova
      .queueClear({ sessionId: this.sessionId })
      .then(({ entries }) => this.applyQueue(entries))
      .catch(() => {});
    this.queuedAttachments.clear();
    this.editingQueuedMessageId = null;
    this.syncQueueTranscript(
      count
        ? `Cleared ${count} queued message${count === 1 ? "" : "s"}.`
        : "Queue already empty.",
    );
    return count;
  }

  steer(text: string): boolean {
    const value = text.trim();
    if (!value) return false;
    if (!this.store.getState().busy && !this.promptActive) {
      void this.submit(value);
      return false;
    }

    void this.enqueueQueuedPrompt(value, [], [], "steer", true);
    return true;
  }

  configuredMcpServers(): acp.McpServer[] {
    return [...this.mcpServers];
  }

  mcpSessionStatus(): McpSessionStatus {
    return {
      configured: this.mcpStatus.configured.map((server) => ({ ...server })),
      connected: [...this.mcpStatus.connected],
      failures: this.mcpStatus.failures.map((failure) => ({ ...failure })),
    };
  }

  skillSessionStatus(): SkillSessionStatus[] {
    return this.skills.map((skill) => ({ ...skill }));
  }

  contextUsageSnapshot(): ContextUsage | null {
    return this.store.getState().contextUsage;
  }

  async refreshContextUsage(): Promise<ContextUsage> {
    await this.ensureSession();
    const sessionId = this.sessionId;
    const model = this.model;
    if (this.contextWindowModel !== model) {
      const request = ++this.contextWindowRequest;
      const contextWindow = await resolveModelContextWindow(
        this.novaClient,
        model,
      );
      if (request === this.contextWindowRequest && model === this.model) {
        this.contextWindow = contextWindow;
        this.contextWindowModel = model;
      }
    }
    if (sessionId !== this.sessionId || !this.agentSessionLoaded) {
      return this.refreshContextUsage();
    }
    const usage = await this.updateContextUsage();
    if (!usage)
      throw new Error(
        "Context usage is unavailable before the session is ready.",
      );
    return usage;
  }

  async close(): Promise<void> {
    await this.acpClient.releaseAllTerminals();
    await this.nova.closeSession({ sessionId: this.sessionId }).catch(() => {});
    await this.connection.close();
  }

  setModel(model: string): void {
    this.model = model;
    this.contextWindow = null;
    this.contextWindowModel = null;
    this.contextWindowRequest++;
    saveDefaultModel(model);
    if (this.agentSessionLoaded) void this.updateContextUsage();
    void this.refreshContextUsage().catch(() => {});
  }

  /**
   * Hands the mode to the agent's permission policy (which decides) and
   * remembers it in the private per-project settings; bypass is never stored.
   */
  setPermissionMode(mode: PermissionMode): void {
    this.store.setState({ permissionMode: mode });
    try {
      savePermissionMode(this.cwd, toAgentPermissionMode(mode));
    } catch {
      // Remembering is a convenience; the session still uses the mode.
    }
    if (this.agentSessionLoaded) this.applyPermissionMode(this.sessionId);
  }

  private applyPermissionMode(sessionId: string): void {
    void this.nova
      .setSessionConfigOption({
        sessionId,
        configId: "permission_mode",
        value: toAgentPermissionMode(this.store.getState().permissionMode),
      })
      .catch(() => {
        this.acpClient.appendError("Could not change the permission mode.");
      });
  }

  setInteractionMode(mode: InteractionMode): void {
    this.applyInteractionMode(mode, `Mode: ${mode}`);
    if (this.agentSessionLoaded) {
      void this.nova
        .setSessionMode({ sessionId: this.sessionId, modeId: mode })
        .catch(() => {});
    }
  }

  /**
   * Starts a brand-new session: aborts any in-flight prompt, drops the
   * queued messages and server-side conversation history, and gets a fresh
   * sessionId — unlike a transcript-only clear, the model has no memory of
   * what came before.
   */
  async startNewSession(): Promise<void> {
    const previousSessionId = this.agentSessionLoaded ? this.sessionId : null;
    this.cancel();
    this.queuedAttachments.clear();
    this.editingQueuedMessageId = null;
    this.title = null;
    this.promptActive = false;
    this.agentSessionLoaded = false;
    this.store.setState({ contextUsage: null, plan: [] });
    if (previousSessionId)
      await this.nova.closeSession({ sessionId: previousSessionId });
    this.sessionReady = this.createSession();
    await this.sessionReady;
    this.store.setState({
      messages: [],
      statusLine: null,
      queuedCount: 0,
      busy: false,
    });
  }

  /** Chat models only: embedding, speech and transcription models can't run a session. */
  async listModels(): Promise<Array<{ id: string; name?: string | null }>> {
    const { data } = await this.novaClient.models.list({ limit: 100 });
    return chatModels(data).map((model) => ({
      id: model.id,
      name: model.name ?? null,
    }));
  }

  /**
   * Replaces a saved model that cannot chat (older logins saved the first
   * model of the list, e.g. an embedding model) and saves the replacement.
   * Runs once; a failed lookup keeps the model and the prompt reports errors.
   */
  ensureUsableModel(): Promise<void> {
    this.modelCheck ??= (async () => {
      try {
        const { data } = await this.novaClient.models.list({ limit: 100 });
        const model = resolveDefaultModel(data, this.model);
        if (!model || model === this.model) return;
        const previous = this.model;
        this.setModel(model);
        this.store.setState({
          statusLine: `${previous} is not a chat model; switched to ${model} (Ctrl+P to pick another).`,
        });
      } catch {
        // Keep the model; a real problem surfaces with the first prompt.
      }
    })();
    return this.modelCheck;
  }

  async supportsImageInput(model = this.model): Promise<boolean> {
    const cached = this.imageSupportByModel.get(model);
    if (cached !== undefined) return cached;
    const supported = await resolveModelSupportsImageInput(
      this.novaClient,
      model,
    );
    this.imageSupportByModel.set(model, supported);
    return supported;
  }

  async compactContext(): Promise<CompactionSummary> {
    if (this.store.getState().busy || this.promptActive) {
      throw new Error(
        "Wait for the active request to finish before compacting context.",
      );
    }
    await this.ensureSession();
    this.store.setState({ busy: true, statusLine: "Compacting context..." });
    try {
      const result = await this.nova.sessionCompact({
        sessionId: this.sessionId,
        model: this.model,
      });
      this.store.setState({
        statusLine: result.compacted
          ? `Context compacted: ${result.removedMessages} older messages summarized.`
          : "Context is already compact.",
      });
      void this.updateContextUsage();
      return result;
    } finally {
      this.store.setState({ busy: false });
    }
  }

  async rewind(turns = 1): Promise<{
    removedCheckpoints: SessionCheckpoint[];
    remainingCheckpoints: SessionCheckpoint[];
  }> {
    if (this.promptActive || this.store.getState().busy) {
      throw new Error("Cancel the active request before rewinding.");
    }
    await this.ensureSession();
    const result = await this.nova.sessionRewind({
      sessionId: this.sessionId,
      turns,
    });
    const stored = loadStoredSession(this.sessionId);
    if (!stored) throw new Error("Rewound session could not be reloaded.");

    this.queuedAttachments.clear();
    this.editingQueuedMessageId = null;
    this.title = stored.title;
    this.acpClient.resetStreaming();
    this.store.setState({
      messages: restoreSessionMessages(stored.messages),
      plan: [],
      queuedCount: 0,
      statusLine: `Rewound ${result.removedCheckpoints.length} turn${result.removedCheckpoints.length === 1 ? "" : "s"}.`,
    });
    void this.updateContextUsage();
    return result;
  }

  async startBackgroundShell(command: string): Promise<BackgroundJobSummary> {
    await this.ensureSession();
    const { job } = await this.nova.backgroundStartTerminal({
      sessionId: this.sessionId,
      command,
    });
    return job;
  }

  async startBackgroundAgent(prompt: string): Promise<BackgroundJobSummary> {
    await this.ensureSession();
    const { job } = await this.nova.backgroundStartPrompt({
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    return job;
  }

  async listBackgroundJobs(
    kind?: BackgroundJobKind,
  ): Promise<BackgroundJobSummary[]> {
    await this.ensureSession();
    const { jobs } = await this.nova.backgroundList({
      sessionId: this.sessionId,
    });
    return kind ? jobs.filter((job) => job.kind === kind) : jobs;
  }

  async backgroundOutput(jobId: string): Promise<OutputResponse> {
    await this.ensureSession();
    return this.nova.backgroundOutput({ jobId });
  }

  async killBackgroundJob(jobId: string): Promise<BackgroundJobSummary> {
    await this.ensureSession();
    const { job } = await this.nova.backgroundKill({ jobId });
    return job;
  }

  async releaseBackgroundJob(jobId: string): Promise<BackgroundJobSummary> {
    await this.ensureSession();
    const { job } = await this.nova.backgroundRelease({ jobId });
    return job;
  }

  private async handleBackgroundLifecycle(
    event: string,
    job: { jobId: string; kind: string; status: string },
  ): Promise<void> {
    if (job.kind !== "prompt" || event !== "completed") return;
    this.completedBackgroundAgentJobs.add(job.jobId);
    await this.maybeHandoffBackgroundAgentOutputs();
  }

  async submit(
    text: string,
    images: PromptImageAttachment[] = [],
    pastes: PromptPasteAttachment[] = [],
  ): Promise<void> {
    const value = text.trim();
    if (!value) return;
    if (this.store.getState().busy || this.promptActive) {
      await this.enqueueQueuedPrompt(value, images, pastes, "followup");
      return;
    }

    await this.executePrompt(value, images, pastes);
  }

  private async executePrompt(
    value: string,
    images: PromptImageAttachment[] = [],
    pastes: PromptPasteAttachment[] = [],
    preparedPrompt?: acp.ContentBlock[],
  ): Promise<void> {
    this.acpClient.appendUserMessage(value);
    this.acpClient.resetStreaming();
    this.promptActive = true;
    this.store.setState({ busy: true, statusLine: null });
    let pendingToolFailure = "Tool stopped before completion.";

    try {
      await this.ensureSession();
      const prompt =
        preparedPrompt ?? (await this.preparePrompt(value, images, pastes));
      const response = await this.nova.prompt({
        sessionId: this.sessionId,
        prompt,
        _meta: {
          "nova-ai-cli/model": this.model,
        },
      });
      if (response.stopReason === "cancelled") {
        pendingToolFailure = "Canceled.";
        this.store.setState({ statusLine: "Request canceled." });
      } else if (response.stopReason === "max_turn_requests") {
        this.store.setState({
          statusLine:
            "Tool-use safety limit reached; the final response uses the results gathered so far.",
        });
      }
    } catch (err) {
      const message =
        err instanceof NovaAIError
          ? `Nova AI request failed (status ${err.status}, requestId ${err.requestId}): ${err.message}`
          : err instanceof Error
            ? err.message
            : "Unknown error.";
      pendingToolFailure = `Request failed: ${message}`;
      this.acpClient.appendError(message);
      this.store.setState({ statusLine: "Request failed." });
    } finally {
      this.promptActive = false;
      this.acpClient.failPendingTools(pendingToolFailure);
      this.acpClient.resetStreaming();
      void this.updateContextUsage();
      this.store.setState({ busy: false });
    }

    await this.runNextQueuedPrompt();
  }

  private async enqueueQueuedPrompt(
    text: string,
    images: PromptImageAttachment[],
    pastes: PromptPasteAttachment[],
    kind: "steer" | "followup",
    front = false,
  ): Promise<void> {
    // Shown as queued right away (the editor and transcript read the mirror
    // synchronously); the agent's response replaces this provisional entry.
    const provisionalId = `pending-${crypto.randomUUID()}`;
    const provisional: PromptQueueEntryView = {
      id: provisionalId,
      version: 0,
      text,
      kind,
      createdAt: new Date().toISOString(),
      editing: false,
    };
    if (this.agentSessionLoaded) {
      const current = this.promptQueueEntries();
      this.applyQueue(front ? [provisional, ...current] : [...current, provisional]);
      this.syncQueueTranscript();
    }
    if (!this.agentSessionLoaded) await this.ensureSession();
    const provisionalPrompt = this.promptBlocks(
      expandPromptPastes(text, pastes),
      images,
    );
    const { entry, entries } = await this.nova.queueEnqueue({
      sessionId: this.sessionId,
      text,
      prompt: provisionalPrompt,
      kind,
      front,
    });
    this.applyQueue(entries);
    this.queuedAttachments.set(entry.id, {
      images: [...images],
      pastes: [...pastes],
    });
    this.syncQueueTranscript(
      kind === "steer"
        ? `Steering at the next tool boundary · queued:${entries.length}`
        : `Queued message ${entries.length}: ${summarizeQueueMessage(text)}`,
    );
    if (kind === "followup") {
      const locked = await this.nova.queueEditBegin({
        sessionId: this.sessionId,
        id: entry.id,
      });
      this.applyQueue(locked.entries);
      const expectedVersion = locked.entries.find(
        (candidate) => candidate.id === entry.id,
      )?.version;
      const prompt = await this.preparePrompt(text, images, pastes);
      const updated = await this.nova.queueUpdate({
        sessionId: this.sessionId,
        id: entry.id,
        prompt,
        editing: false,
        expectedVersion,
      });
      this.applyQueue(updated.entries);
    }
    if (!this.store.getState().busy && !this.promptActive) {
      await this.runNextQueuedPrompt();
    }
  }

  private syncQueueTranscript(statusLine?: string): void {
    const entries = this.promptQueueEntries();
    this.store.setState((state) => {
      const transcript = state.messages.filter(
        (message) => !(message.role === "user" && message.queued),
      );
      const queued: UIMessage[] = entries.map((prompt) => ({
        id: prompt.id,
        role: "user",
        text: prompt.text,
        queued: prompt.kind,
      }));
      return {
        messages: [...transcript, ...queued],
        queuedCount: entries.length,
        ...(statusLine !== undefined ? { statusLine } : {}),
      };
    });
  }

  private async runNextQueuedPrompt(): Promise<void> {
    if (this.store.getState().busy || this.promptActive) return;
    if (!this.agentSessionLoaded) return;
    const { entry: next } = await this.nova.queueTakeNext({
      sessionId: this.sessionId,
    });
    if (!next) return;
    this.applyQueue(this.promptQueueEntries().filter((entry) => entry.id !== next.id));
    this.queuedAttachments.delete(next.id);
    if (this.editingQueuedMessageId === next.id)
      this.editingQueuedMessageId = null;
    this.syncQueueTranscript();
    await this.executePrompt(next.text, [], [], next.prompt);
  }

  private async finalizeQueuedMessageEdit(
    id: string,
    text: string,
  ): Promise<void> {
    const attachments = this.queuedAttachments.get(id) ?? {
      images: [],
      pastes: [],
    };
    const prompt = await this.preparePrompt(
      text,
      attachments.images,
      attachments.pastes,
    );
    const { updated, entries } = await this.nova.queueUpdate({
      sessionId: this.sessionId,
      id,
      text,
      prompt,
      editing: false,
    });
    this.applyQueue(entries);
    if (!updated) return;
    if (this.editingQueuedMessageId === id) this.editingQueuedMessageId = null;
    this.syncQueueTranscript("Queued message updated.");
    if (!this.store.getState().busy && !this.promptActive) {
      await this.runNextQueuedPrompt();
    }
  }

  /** The local mirror of the agent's queue (responses and _nova/queue/changed). */
  private promptQueueEntries(): PromptQueueEntryView[] {
    if (!this.agentSessionLoaded) return [];
    return this.acpClient.queueSnapshot;
  }

  private applyQueue(entries: PromptQueueEntryView[]): void {
    this.acpClient.queueSnapshot = entries;
  }

  private async preparePrompt(
    text: string,
    images: PromptImageAttachment[],
    pastes: PromptPasteAttachment[],
  ): Promise<acp.ContentBlock[]> {
    const modelText = await this.injectFileMentions(
      expandPromptPastes(text, pastes),
    );
    return this.promptBlocks(modelText, images);
  }

  private promptBlocks(
    text: string,
    images: PromptImageAttachment[],
  ): acp.ContentBlock[] {
    return [
      { type: "text", text },
      ...images.map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType,
      })),
    ];
  }

  private async createSession(): Promise<void> {
    this.loadMcpConfiguration(this.cwd);
    await this.initialized;
    const { sessionId, _meta } = await this.nova.newSession({
      cwd: this.cwd,
      mcpServers: this.mcpServers,
    });
    this.sessionId = sessionId;
    this.applyMcpStatus(_meta);
    this.applySkillStatus(_meta);
    this.agentSessionLoaded = true;
    this.applyQueue([]);
    void this.nova
      .setSessionMode({ sessionId, modeId: this.interactionMode })
      .catch(() => {});
    this.applyPermissionMode(sessionId);
    void this.updateContextUsage();
    void this.refreshContextUsage().catch(() => {});
    if (this.mcpStatus.failures.length > 0) {
      this.store.setState({
        statusLine: `MCP: ${this.mcpStatus.failures.length} server${this.mcpStatus.failures.length === 1 ? "" : "s"} failed to connect.`,
      });
    }
    this.store.setState({ sessionId });
  }

  private applyMcpStatus(
    meta: Record<string, unknown> | null | undefined,
  ): void {
    const value = meta?.["nova-ai-cli/mcp"];
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const configured = Array.isArray(record.configured)
      ? record.configured.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const item = entry as Record<string, unknown>;
          return typeof item.name === "string" &&
            typeof item.transport === "string"
            ? [{ name: item.name, transport: item.transport }]
            : [];
        })
      : [];
    const connected = Array.isArray(record.connected)
      ? record.connected.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    const failures = Array.isArray(record.failures)
      ? record.failures.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const item = entry as Record<string, unknown>;
          return typeof item.serverName === "string" &&
            typeof item.message === "string"
            ? [{ serverName: item.serverName, message: item.message }]
            : [];
        })
      : [];
    this.mcpStatus = {
      configured,
      connected,
      failures: [...this.mcpConfigurationFailures, ...failures],
    };
  }

  private loadMcpConfiguration(cwd: string): void {
    const configuration = readWorkspaceMcpConfiguration(cwd);
    this.mcpServers = configuration.servers;
    this.mcpConfigurationFailures = configuration.failures;
    this.mcpStatus = {
      configured: this.mcpServers.map((server) => ({
        name: server.name,
        transport: "type" in server ? server.type : "stdio",
      })),
      connected: [],
      failures: [...this.mcpConfigurationFailures],
    };
  }

  private applySkillStatus(
    meta: Record<string, unknown> | null | undefined,
  ): void {
    const value = meta?.["nova-ai-cli/skills"];
    if (!Array.isArray(value)) return;
    this.skills = value.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const skill = entry as Record<string, unknown>;
      return typeof skill.name === "string" &&
        typeof skill.description === "string" &&
        (skill.source === "user" || skill.source === "workspace") &&
        typeof skill.path === "string"
        ? [
            {
              name: skill.name,
              description: skill.description,
              source: skill.source,
              path: skill.path,
            },
          ]
        : [];
    });
  }

  private async ensureSession(): Promise<void> {
    await this.ensureUsableModel();
    await this.sessionReady;
    if (!this.agentSessionLoaded) {
      this.sessionReady = this.createSession();
      await this.sessionReady;
    }
  }

  private applyInteractionMode(
    mode: InteractionMode,
    statusLine: string,
  ): void {
    this.interactionMode = mode;
    this.store.setState({ interactionMode: mode, statusLine });
    if (this.agentSessionLoaded) void this.updateContextUsage();
  }

  /** Asks the agent for the context estimate; only the newest answer is shown. */
  private async updateContextUsage(): Promise<ContextUsage | null> {
    if (!this.agentSessionLoaded) return null;
    const request = ++this.contextUsageRequest;
    const sessionId = this.sessionId;
    try {
      const usage = await this.nova.sessionContextUsage({
        sessionId,
        contextWindow: this.contextWindow,
        mode: this.interactionMode,
      });
      if (request === this.contextUsageRequest && sessionId === this.sessionId) {
        this.store.setState({ contextUsage: usage });
      }
      return usage;
    } catch {
      return null;
    }
  }

  private async maybeHandoffBackgroundAgentOutputs(): Promise<void> {
    if (
      this.handoffActive ||
      this.promptActive ||
      this.completedBackgroundAgentJobs.size === 0
    )
      return;
    const jobs = (
      await this.nova.backgroundList({ sessionId: this.sessionId })
    ).jobs.filter((job) => job.kind === "prompt");
    if (jobs.some((job) => job.status === "running")) return;

    this.handoffActive = true;
    const jobIds = [...this.completedBackgroundAgentJobs];
    this.completedBackgroundAgentJobs.clear();

    try {
      // The agent queues each job's handoff note and injects it into history
      // when this prompt starts, so the trigger only needs to reference them.
      await this.submit(
        `Background agent jobs have finished (${jobIds.join(", ")}). Their handoff notes precede this message; use them to continue the main task, and call read_background_output with a jobId if you need a full transcript.`,
      );
    } finally {
      this.handoffActive = false;
    }
  }

  private async injectFileMentions(text: string): Promise<string> {
    const mentioned = findWorkspaceFileMentions(text, this.cwd);
    if (mentioned.length === 0) return text;

    const blocks = await Promise.all(
      mentioned.map(async ({ absolutePath, relativePath }) => {
        try {
          const { content } = await this.acpClient.readTextFile({
            sessionId: this.sessionId,
            path: absolutePath,
          });
          return `\n--- file: ${relativePath} ---\n${content}\n---`;
        } catch (err) {
          return `\n[could not read @${relativePath}: ${err instanceof Error ? err.message : "unknown error"}]`;
        }
      }),
    );

    return `${text}${blocks.join("")}`;
  }
}

function summarizeQueueMessage(text: string): string {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine;
}

function mergeReferencedImages(
  existing: PromptImageAttachment[],
  added: PromptImageAttachment[],
  text: string,
): PromptImageAttachment[] {
  const byMarker = new Map(
    [...existing, ...added].map((image) => [image.marker, image]),
  );
  return [...byMarker.values()].filter((image) => text.includes(image.marker));
}

function mergeReferencedPastes(
  existing: PromptPasteAttachment[],
  added: PromptPasteAttachment[],
  text: string,
): PromptPasteAttachment[] {
  const byMarker = new Map(
    [...existing, ...added].map((paste) => [paste.marker, paste]),
  );
  return [...byMarker.values()].filter((paste) => text.includes(paste.marker));
}

/** The TUI's mode names ↔ the agent's permission_mode values. */
export function toAgentPermissionMode(mode: PermissionMode): AgentPermissionMode {
  return mode === "bypassAll" ? "bypassPermissions" : mode === "acceptEdits" ? "acceptEdits" : "default";
}

export function fromAgentPermissionMode(mode: AgentPermissionMode): PermissionMode {
  return mode === "bypassPermissions" ? "bypassAll" : mode === "acceptEdits" ? "acceptEdits" : "ask";
}
