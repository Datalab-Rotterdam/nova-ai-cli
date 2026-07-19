import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
  NovaAI,
  NovaAIError,
  type ChatMessage,
} from "@datalabrotterdam/nova-sdk";
import { NovaAgent } from "../../acp/agent.js";
import {
  extractToolCall,
  stripToolCallMarkup,
} from "../../acp/tools/marker.js";
import type {
  BackgroundJobKind,
  BackgroundJobSummary,
  OutputResponse,
} from "../../acp/background.js";
import type { StoredCredentials } from "../../acp/credentials.js";
import type { PromptQueueEntryView } from "../../acp/prompt-queue.js";
import { writeCredentials } from "../../acp/credentials.js";
import { loadStoredSession } from "../../acp/sessions.js";
import type { SessionCheckpoint } from "../../acp/sessions.js";
import { discoverSkills } from "../../acp/skills.js";
import { chatContentToText } from "../../core/chat-content.js";
import {
  resolveModelContextWindow,
  type ContextCompactionResult,
} from "../../core/context-compaction.js";
import type { ContextUsage } from "../../core/context-usage.js";
import { resolveModelSupportsImageInput } from "../../core/model-capabilities.js";
import { stripReasoningTags } from "../../core/reasoning-tags.js";
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
  load_memory: { kind: "read", mutating: false },
  list_background_jobs: { kind: "read", mutating: false },
  read_background_output: { kind: "read", mutating: false },
  wait_for_background_jobs: { kind: "think", mutating: false },
  ask_user: { kind: "think", mutating: false },
  update_plan: { kind: "think", mutating: false },
  enter_plan_mode: { kind: "switch_mode", mutating: false },
  write_file: { kind: "edit", mutating: true },
  edit_file: { kind: "edit", mutating: true },
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
  const restored: UIMessage[] = [];
  let pendingTool: ToolCallView | null = null;

  const settleMissingToolResult = () => {
    if (!pendingTool) return;
    pendingTool.status = "failed";
    pendingTool.output =
      "Tool result was not persisted before the session ended.";
    pendingTool = null;
  };

  for (const message of messages) {
    const rawText = chatContentToText(message.content);
    if (message.role === "assistant") {
      settleMissingToolResult();
      const toolCall = extractToolCall(rawText);
      const visibleText = stripReasoningTags(stripToolCallMarkup(rawText));
      if (visibleText.trim()) {
        restored.push({
          id: uid(),
          role: "assistant",
          text: visibleText,
          streaming: false,
        });
      }
      if (toolCall) {
        const metadata = RESTORED_TOOL_METADATA[toolCall.name] ?? {
          // Persisted ACP/MCP calls do not currently retain annotations. Keep
          // unknown calls compact without falsely labelling them as changes.
          kind: "execute",
          mutating: false,
        };
        pendingTool = {
          toolCallId: uid(),
          name: toolCall.name,
          args: toolCall.args,
          kind: metadata.kind,
          mutating: metadata.mutating,
          status: "pending",
          output: null,
          diff: null,
        };
        if (toolCall.name !== "update_plan") {
          restored.push({ id: uid(), role: "tool", call: pendingTool });
        }
      }
      continue;
    }

    if (message.role !== "user") continue;
    const outcome = pendingTool ? storedToolOutcome(rawText) : null;
    if (pendingTool && outcome) {
      pendingTool.status = outcome.status;
      pendingTool.output = outcome.output;
      pendingTool = null;
      continue;
    }

    settleMissingToolResult();
    restored.push({ id: uid(), role: "user", text: rawText });
  }

  settleMissingToolResult();
  return restored;
}

function storedToolOutcome(
  text: string,
): Pick<ToolCallView, "status" | "output"> | null {
  if (text.startsWith("Tool result:")) {
    return {
      status: "completed",
      output: text.slice("Tool result:".length).trimStart(),
    };
  }
  if (text.startsWith("Tool error:")) {
    return {
      status: "failed",
      output: text.slice("Tool error:".length).trimStart(),
    };
  }
  if (
    text === "Tool call rejected by user." ||
    /^Tool "[^"]+" is not available\.$/.test(text) ||
    /^Tool call "[^"]+" has invalid arguments:/.test(text)
  ) {
    return { status: "failed", output: text };
  }
  return null;
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

  private readonly agent = new NovaAgent();
  private readonly acpClient: TuiAcpClient;
  private readonly acpContext: acp.AgentContext;
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
    this.acpContext = this.acpClient.context();
    this.agent.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: this.acpClient.capabilities,
    });
    this.novaClient = new NovaAI({ apiKey: credentials.apiKey });
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
    if (previousSessionId) this.agent.cancel({ sessionId: previousSessionId });
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
    this.sessionReady = (
      previousSessionId
        ? this.agent.closeSession({ sessionId: previousSessionId })
        : Promise.resolve({})
    )
      .then(() =>
        this.agent.loadSession(
          {
            sessionId: stored.sessionId,
            cwd: stored.cwd,
            mcpServers: this.mcpServers,
          },
          silentContext(this.acpContext),
        ),
      )
      .then((response) => {
        this.applyMcpStatus(response._meta);
        this.applySkillStatus(response._meta);
        this.agentSessionLoaded = true;
        this.agent.setSessionMode({
          sessionId: this.sessionId,
          modeId: this.interactionMode,
        });
        this.updateContextUsage();
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
    this.agent.cancel({ sessionId: this.sessionId });
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

  beginQueuedMessageEdit(id: string): boolean {
    if (!this.agentSessionLoaded) return false;
    const { updated } = this.agent.beginQueuedPromptEdit({
      sessionId: this.sessionId,
      id,
    });
    if (!updated) return false;
    this.editingQueuedMessageId = id;
    this.syncQueueTranscript();
    this.store.setState({ statusLine: "Editing queued message." });
    return true;
  }

  updateQueuedMessage(id: string, text: string): boolean {
    if (!this.agentSessionLoaded) return false;
    const { updated } = this.agent.updateQueuedPrompt({
      sessionId: this.sessionId,
      id,
      text,
    });
    if (!updated) return false;
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
      this.agent.removeQueuedPrompt({ sessionId: this.sessionId, id });
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
      this.agent.updateQueuedPrompt({
        sessionId: this.sessionId,
        id,
        text: value,
      });
      void this.finalizeQueuedMessageEdit(id, value);
    }
    return true;
  }

  clearQueuedMessages(): number {
    if (!this.agentSessionLoaded) return 0;
    const { cleared: count } = this.agent.clearPromptQueue({
      sessionId: this.sessionId,
    });
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
    const usage = this.updateContextUsage();
    if (!usage)
      throw new Error(
        "Context usage is unavailable before the session is ready.",
      );
    return usage;
  }

  async close(): Promise<void> {
    await this.acpClient.releaseAllTerminals();
    await this.agent.closeSession({ sessionId: this.sessionId });
  }

  setModel(model: string): void {
    this.model = model;
    this.contextWindow = null;
    this.contextWindowModel = null;
    this.contextWindowRequest++;
    writeCredentials({ ...this.credentials, defaultModel: model });
    if (this.agentSessionLoaded) this.updateContextUsage();
    void this.refreshContextUsage().catch(() => {});
  }

  setInteractionMode(mode: InteractionMode): void {
    this.applyInteractionMode(mode, `Mode: ${mode}`);
    if (this.agentSessionLoaded) {
      this.agent.setSessionMode({ sessionId: this.sessionId, modeId: mode });
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
      await this.agent.closeSession({ sessionId: previousSessionId });
    this.sessionReady = this.createSession();
    await this.sessionReady;
    this.store.setState({
      messages: [],
      statusLine: null,
      queuedCount: 0,
      busy: false,
    });
  }

  async listModels(): Promise<Array<{ id: string; name?: string | null }>> {
    const { data } = await this.novaClient.models.list();
    return data
      .filter(
        (model) =>
          Array.isArray(model.capabilities) &&
          model.capabilities.includes("tools"),
      )
      .map((model) => ({ id: model.id, name: model.name ?? null }));
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

  async compactContext(): Promise<ContextCompactionResult> {
    if (this.store.getState().busy || this.promptActive) {
      throw new Error(
        "Wait for the active request to finish before compacting context.",
      );
    }
    await this.ensureSession();
    this.store.setState({ busy: true, statusLine: "Compacting context..." });
    try {
      const result = await this.agent.compactSession({
        sessionId: this.sessionId,
        model: this.model,
      });
      this.store.setState({
        statusLine: result.compacted
          ? `Context compacted: ${result.removedMessages} older messages summarized.`
          : "Context is already compact.",
      });
      this.updateContextUsage();
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
    const result = await this.agent.rewindSession({
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
    this.updateContextUsage();
    return result;
  }

  async startBackgroundShell(command: string): Promise<BackgroundJobSummary> {
    await this.ensureSession();
    const { job } = await this.agent.startBackgroundTerminal(
      { sessionId: this.sessionId, command },
      this.acpContext,
    );
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

  async listBackgroundJobs(
    kind?: BackgroundJobKind,
  ): Promise<BackgroundJobSummary[]> {
    await this.ensureSession();
    const { jobs } = this.agent.listBackgroundJobs({
      sessionId: this.sessionId,
    });
    return kind ? jobs.filter((job) => job.kind === kind) : jobs;
  }

  async backgroundOutput(jobId: string): Promise<OutputResponse> {
    await this.ensureSession();
    return this.agent.backgroundOutput({ jobId }, this.acpContext);
  }

  async killBackgroundJob(jobId: string): Promise<BackgroundJobSummary> {
    await this.ensureSession();
    const { job } = await this.agent.killBackgroundJob(
      { jobId },
      this.acpContext,
    );
    return job;
  }

  async releaseBackgroundJob(jobId: string): Promise<BackgroundJobSummary> {
    await this.ensureSession();
    const { job } = await this.agent.releaseBackgroundJob(
      { jobId },
      this.acpContext,
    );
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
      const response = await this.agent.prompt(
        {
          sessionId: this.sessionId,
          prompt,
          _meta: {
            "nova-ai-cli/model": this.model,
          },
        },
        this.acpContext,
      );
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
      this.updateContextUsage();
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
    if (!this.agentSessionLoaded) await this.ensureSession();
    const provisionalPrompt = this.promptBlocks(
      expandPromptPastes(text, pastes),
      images,
    );
    const { entry, entries } = this.agent.queuePrompt({
      sessionId: this.sessionId,
      text,
      prompt: provisionalPrompt,
      kind,
      front,
    });
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
      const locked = this.agent.beginQueuedPromptEdit({
        sessionId: this.sessionId,
        id: entry.id,
      });
      const expectedVersion = locked.entries.find(
        (candidate) => candidate.id === entry.id,
      )?.version;
      const prompt = await this.preparePrompt(text, images, pastes);
      this.agent.updateQueuedPrompt({
        sessionId: this.sessionId,
        id: entry.id,
        prompt,
        editing: false,
        expectedVersion,
      });
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
    const next = this.agent.takeNextQueuedPrompt({
      sessionId: this.sessionId,
    });
    if (!next) return;
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
    const { updated } = this.agent.updateQueuedPrompt({
      sessionId: this.sessionId,
      id,
      text,
      prompt,
      editing: false,
    });
    if (!updated) return;
    if (this.editingQueuedMessageId === id) this.editingQueuedMessageId = null;
    this.syncQueueTranscript("Queued message updated.");
    if (!this.store.getState().busy && !this.promptActive) {
      await this.runNextQueuedPrompt();
    }
  }

  private promptQueueEntries(): PromptQueueEntryView[] {
    if (!this.agentSessionLoaded) return [];
    return this.agent.listPromptQueue({ sessionId: this.sessionId }).entries;
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
    const { sessionId, _meta } = await this.agent.newSession({
      cwd: this.cwd,
      mcpServers: this.mcpServers,
    });
    this.sessionId = sessionId;
    this.applyMcpStatus(_meta);
    this.applySkillStatus(_meta);
    this.agentSessionLoaded = true;
    this.agent.setSessionMode({
      sessionId,
      modeId: this.interactionMode,
    });
    this.updateContextUsage();
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
    if (this.agentSessionLoaded) this.updateContextUsage();
  }

  private updateContextUsage(): ContextUsage | null {
    if (!this.agentSessionLoaded) return null;
    const usage = this.agent.contextUsage({
      sessionId: this.sessionId,
      contextWindow: this.contextWindow,
      mode: this.interactionMode,
    });
    this.store.setState({ contextUsage: usage });
    return usage;
  }

  private async maybeHandoffBackgroundAgentOutputs(): Promise<void> {
    if (
      this.handoffActive ||
      this.promptActive ||
      this.completedBackgroundAgentJobs.size === 0
    )
      return;
    const jobs = this.agent
      .listBackgroundJobs({ sessionId: this.sessionId })
      .jobs.filter((job) => job.kind === "prompt");
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

function silentContext(context: acp.AgentContext): acp.AgentContext {
  return {
    request: (
      method: string,
      params?: unknown,
      options?: acp.SendRequestOptions,
    ) => context.request(method, params, options),
    notify: async () => {},
  } as unknown as acp.AgentContext;
}
