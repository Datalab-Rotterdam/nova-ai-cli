import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  CreateElicitationRequest,
  CreateElicitationResponse,
  KillTerminalRequest,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import type { UserInputResponse } from "../../core/user-questions.js";
import type { PromptQueueEntryView } from "../../acp/prompt-queue.js";
import {
  isInteractionMode,
  type InteractionMode,
} from "../../core/interaction-modes.js";
import {
  fromElicitationRequest,
  toElicitationResponse,
} from "../../acp/user-questions.js";
import {
  evaluatePermissionRules,
  exactPermissionRule,
  type PermissionRuleSet,
} from "../settings/permission-rules.js";
import {
  addAllowedPermissionRule,
  readWorkspaceSettings,
} from "../settings/workspace-settings.js";
import type { Store } from "../state/store.js";
import type {
  BackgroundJobView,
  PlanEntryView,
  ToolCallView,
  ToolDiffView,
  UIMessage,
  UIState,
} from "../state/types.js";

const DEFAULT_OUTPUT_LIMIT = 100_000;
const AUTO_EDIT_TOOL_NAMES = new Set(["write_file", "edit_file"]);

let nextMessageId = 0;
function uid(): string {
  nextMessageId += 1;
  return `m${nextMessageId}`;
}

type TerminalRecord = {
  child: ChildProcessWithoutNullStreams;
  command: string;
  toolCallId: string | null;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  previewTimer: ReturnType<typeof setTimeout> | null;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
  exitPromise: Promise<WaitForTerminalExitResponse>;
};

export class TuiAcpClient {
  readonly capabilities = {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    elicitation: { form: {} },
  } satisfies acp.ClientCapabilities;

  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly allowedForSession = new Set<string>();
  private readonly permissionRules: PermissionRuleSet;
  private streamingMessageId: string | null = null;
  private nextTerminalId = 0;

  constructor(
    private readonly store: Store<UIState>,
    private readonly cwd: string,
    private readonly onBackgroundLifecycle?: (
      event: string,
      job: BackgroundJobView,
    ) => void | Promise<void>,
    private readonly onInteractionModeChange?: (mode: InteractionMode) => void,
  ) {
    const configured = readWorkspaceSettings(cwd).permissions;
    this.permissionRules = {
      allow: [...(configured?.allow ?? [])],
      deny: [...(configured?.deny ?? [])],
    };
  }

  context(): acp.AgentContext {
    return {
      request: (
        method: string,
        params?: unknown,
        options?: acp.SendRequestOptions,
      ) => this.handleRequest(method, params, options),
      notify: (method: string, params?: unknown) =>
        this.handleNotification(method, params),
    } as unknown as acp.AgentContext;
  }

  resetStreaming(): void {
    if (this.streamingMessageId) {
      const id = this.streamingMessageId;
      this.store.setState((state) => ({
        messages: state.messages.map((message) =>
          message.id === id && message.role === "assistant"
            ? { ...message, streaming: false }
            : message,
        ),
      }));
    }
    this.streamingMessageId = null;
  }

  appendUserMessage(text: string): void {
    this.appendMessage({ id: uid(), role: "user", text });
  }

  appendError(text: string): void {
    this.appendMessage({ id: uid(), role: "error", text });
  }

  failPendingTools(reason: string): number {
    let count = 0;
    this.store.setState((state) => ({
      messages: state.messages.map((message) => {
        if (message.role !== "tool" || message.call.status !== "pending")
          return message;
        count++;
        const output = message.call.output
          ? `${message.call.output.replace(/\s+$/, "")}\n${reason}`
          : reason;
        return {
          ...message,
          call: { ...message.call, status: "failed", output },
        };
      }),
    }));
    return count;
  }

  async releaseAllTerminals(): Promise<void> {
    await Promise.all(
      [...this.terminals.keys()].map((terminalId) =>
        this.releaseTerminal({
          sessionId: this.store.getState().sessionId,
          terminalId,
        }),
      ),
    );
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    let content = await readFile(params.path, "utf8");
    if (params.line || params.limit) {
      const start = Math.max((params.line ?? 1) - 1, 0);
      const end = params.limit ? start + params.limit : undefined;
      content = content.split(/\r?\n/).slice(start, end).join("\n");
    }
    return { content };
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<void> {
    await mkdir(dirname(params.path), { recursive: true });
    await writeFile(params.path, params.content, "utf8");
  }

  async createTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    const terminalId = `tui-${++this.nextTerminalId}`;
    const outputByteLimit = params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT;
    const env = { ...process.env };
    for (const variable of params.env ?? [])
      env[variable.name] = variable.value;

    const child = params.args?.length
      ? spawn(params.command, params.args, { cwd: params.cwd ?? this.cwd, env })
      : spawn(params.command, {
          cwd: params.cwd ?? this.cwd,
          env,
          shell: true,
        });

    const record: TerminalRecord = {
      child,
      command: params.command,
      toolCallId: this.findPendingTerminalTool(params.command),
      output: "",
      truncated: false,
      outputByteLimit,
      previewTimer: null,
      exitStatus: null,
      exitPromise: Promise.resolve({}),
    };

    const append = (chunk: Buffer) => {
      record.output += chunk.toString("utf8");
      if (record.output.length > record.outputByteLimit) {
        record.output = record.output.slice(
          record.output.length - record.outputByteLimit,
        );
        record.truncated = true;
      }
      this.scheduleTerminalPreview(record);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    record.exitPromise = new Promise((resolve) => {
      child.on("error", (err) => {
        record.output += `\n${err.message}`;
        this.flushTerminalPreview(record);
        record.exitStatus = { exitCode: null, signal: "error" };
        resolve(record.exitStatus);
      });
      child.on("close", (exitCode, signal) => {
        this.flushTerminalPreview(record);
        record.exitStatus = { exitCode, signal };
        resolve(record.exitStatus);
      });
    });

    this.terminals.set(terminalId, record);
    return { terminalId };
  }

  async terminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    const record = this.requireTerminal(params.terminalId);
    return {
      output: record.output,
      truncated: record.truncated,
      exitStatus: record.exitStatus,
    };
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    return this.requireTerminal(params.terminalId).exitPromise;
  }

  async killTerminal(params: KillTerminalRequest): Promise<void> {
    const record = this.requireTerminal(params.terminalId);
    if (!record.exitStatus) record.child.kill();
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<void> {
    const record = this.terminals.get(params.terminalId);
    if (!record) return;
    if (record.previewTimer) clearTimeout(record.previewTimer);
    if (!record.exitStatus) record.child.kill();
    this.terminals.delete(params.terminalId);
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const permissionMode = this.store.getState().permissionMode;
    const toolName = params.toolCall.title ?? "tool";
    const kind = params.toolCall.kind ?? "other";
    const args = toRecord(params.toolCall.rawInput);
    const ruleDecision = evaluatePermissionRules(
      this.permissionRules,
      toolName,
      args,
    );
    if (ruleDecision === "deny") return selected("reject");
    if (ruleDecision === "allow") return selected("allow");
    if (permissionMode === "bypassAll") return selected("allow");
    if (permissionMode === "acceptEdits" && AUTO_EDIT_TOOL_NAMES.has(toolName))
      return selected("allow");

    const key = `${toolName}:${JSON.stringify(args)}`;
    if (this.allowedForSession.has(key)) return selected("allow");

    return new Promise<RequestPermissionResponse>((resolve) => {
      this.store.setState({
        pendingPermission: {
          toolCallId: params.toolCall.toolCallId,
          toolName,
          kind,
          args,
          resolve: (allow, scope) => {
            if (allow && scope === "session") this.allowedForSession.add(key);
            if (allow && scope === "always") {
              const rule = exactPermissionRule(toolName, args);
              this.permissionRules.allow = [
                ...(this.permissionRules.allow ?? []),
                rule,
              ];
              addAllowedPermissionRule(this.cwd, rule);
            }
            this.store.setState({ pendingPermission: null });
            resolve(allow ? selected("allow") : selected("reject"));
          },
        },
      });
    });
  }

  async createElicitation(
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    const request = fromElicitationRequest(params);
    if (!request) return { action: "decline" };
    const id = `question-${uid()}`;

    return new Promise<CreateElicitationResponse>((resolve) => {
      let settled = false;
      const finish = (response: UserInputResponse) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (this.store.getState().pendingQuestion?.id === id) {
          this.store.setState({ pendingQuestion: null });
        }
        resolve(toElicitationResponse(request, response));
      };
      const abort = () => finish({ action: "cancel", answers: [] });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      this.store.setState({
        pendingQuestion: { id, request, resolve: finish },
      });
    });
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        if (update.content.type === "text") {
          this.resetStreaming();
          this.appendUserMessage(update.content.text);
        }
        return;
      case "agent_message_chunk":
        if (update.content.type === "text")
          this.appendStreamingText(update.content.text);
        return;
      case "agent_thought_chunk":
        if (update.content.type === "text" && update.content.text.trim()) {
          this.resetStreaming();
          this.appendMessage({
            id: uid(),
            role: "assistant",
            text: update.content.text,
            streaming: false,
          });
        }
        return;
      case "current_mode_update":
        if (isInteractionMode(update.currentModeId)) {
          this.onInteractionModeChange?.(update.currentModeId);
        }
        return;
      case "plan":
        this.store.setState({
          plan: update.entries.map(
            ({ content, priority, status }): PlanEntryView => ({
              content,
              priority,
              status,
            }),
          ),
        });
        return;
      case "tool_call":
        // A tool call ends the preceding assistant text segment.  Keep the
        // rendered message, but explicitly settle it before beginning the
        // tool card; otherwise its streaming marker can animate forever.
        this.resetStreaming();
        if (update.title === "update_plan") return;
        this.appendMessage({
          id: uid(),
          role: "tool",
          call: {
            toolCallId: update.toolCallId,
            name: update.title,
            mutating:
              typeof update._meta?.["nova-ai-cli/mutating"] === "boolean"
                ? update._meta["nova-ai-cli/mutating"]
                : update.kind !== "read" && update.kind !== "search",
            kind: update.kind ?? "other",
            args: toRecord(update.rawInput),
            status: normalizeToolStatus(update.status),
            output: null,
            diff: null,
          },
        });
        return;
      case "tool_call_update":
        this.patchToolCall(update.toolCallId, {
          status: normalizeToolStatus(update.status),
          output: extractToolOutput(update),
          diff: extractToolDiff(update),
        });
        return;
      default:
        return;
    }
  }

  async backgroundUpdate(params: unknown): Promise<void> {
    if (!params || typeof params !== "object") return;
    const event = "event" in params ? String(params.event) : "background";
    const job = parseBackgroundJob("job" in params ? params.job : null);
    if (!job) return;

    const preview =
      job.outputPath && event !== "started"
        ? await readPreview(job.outputPath)
        : "";
    this.upsertBackgroundMessage({ ...job, preview });
    this.store.setState({ statusLine: `Background ${event}: ${job.title}` });
    await this.onBackgroundLifecycle?.(event, job);
  }

  queueChanged(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const rawEntries =
      "entries" in params && Array.isArray(params.entries)
        ? params.entries
        : [];
    const entries = rawEntries.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const entry = value as Partial<PromptQueueEntryView>;
      if (
        typeof entry.id !== "string" ||
        typeof entry.text !== "string" ||
        (entry.kind !== "steer" && entry.kind !== "followup")
      ) {
        return [];
      }
      return [{ id: entry.id, text: entry.text, kind: entry.kind }];
    });
    this.store.setState((state) => {
      const transcript = state.messages.filter(
        (message) => !(message.role === "user" && message.queued),
      );
      const queued: UIMessage[] = entries.map((entry) => ({
        id: entry.id,
        role: "user",
        text: entry.text,
        queued: entry.kind,
      }));
      return {
        messages: [...transcript, ...queued],
        queuedCount: queued.length,
      };
    });
  }

  private async handleRequest(
    method: string,
    params?: unknown,
    options?: acp.SendRequestOptions,
  ): Promise<unknown> {
    options?.cancellationSignal?.throwIfAborted();
    switch (method) {
      case "fs/read_text_file":
        return this.readTextFile(params as ReadTextFileRequest);
      case "fs/write_text_file":
        return this.writeTextFile(params as WriteTextFileRequest);
      case "terminal/create":
        return this.createTerminal(params as CreateTerminalRequest);
      case "terminal/output":
        return this.terminalOutput(params as TerminalOutputRequest);
      case "terminal/wait_for_exit":
        return this.waitForTerminalExit(params as WaitForTerminalExitRequest);
      case "terminal/kill":
        return this.killTerminal(params as KillTerminalRequest);
      case "terminal/release":
        return this.releaseTerminal(params as ReleaseTerminalRequest);
      case "session/request_permission":
        return this.requestPermission(params as RequestPermissionRequest);
      case "elicitation/create":
        return this.createElicitation(
          params as CreateElicitationRequest,
          options?.cancellationSignal,
        );
      default:
        throw new Error(`Unsupported ACP client request: ${method}`);
    }
  }

  private async handleNotification(
    method: string,
    params?: unknown,
  ): Promise<void> {
    switch (method) {
      case "session/update":
        return this.sessionUpdate(params as SessionNotification);
      case "background/update":
        return this.backgroundUpdate(params);
      case "queue/changed":
        return this.queueChanged(params);
      default:
        return;
    }
  }

  private requireTerminal(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (!record) throw new Error(`Terminal ${terminalId} not found`);
    return record;
  }

  private findPendingTerminalTool(command: string): string | null {
    const messages = this.store.getState().messages;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (
        !message ||
        message.role !== "tool" ||
        message.call.status !== "pending"
      )
        continue;
      if (message.call.name === "run_package_script")
        return message.call.toolCallId;
      if (
        message.call.name === "run_command" &&
        message.call.args.command === command
      )
        return message.call.toolCallId;
    }
    return null;
  }

  private scheduleTerminalPreview(record: TerminalRecord): void {
    if (!record.toolCallId || record.previewTimer) return;
    record.previewTimer = setTimeout(() => {
      record.previewTimer = null;
      this.patchToolCall(record.toolCallId!, { output: record.output });
    }, 50);
    record.previewTimer.unref?.();
  }

  private flushTerminalPreview(record: TerminalRecord): void {
    if (record.previewTimer) {
      clearTimeout(record.previewTimer);
      record.previewTimer = null;
    }
    if (record.toolCallId && record.output)
      this.patchToolCall(record.toolCallId, { output: record.output });
  }

  private appendStreamingText(text: string): void {
    if (!this.streamingMessageId) {
      const id = uid();
      this.streamingMessageId = id;
      this.appendMessage({ id, role: "assistant", text, streaming: true });
      return;
    }

    this.store.setState((state) => ({
      messages: state.messages.map((message) =>
        message.id === this.streamingMessageId && message.role === "assistant"
          ? { ...message, text: message.text + text }
          : message,
      ),
    }));
  }

  private patchToolCall(
    toolCallId: string,
    patch: Partial<ToolCallView>,
  ): void {
    this.store.setState((state) => ({
      messages: state.messages.map((message) =>
        message.role === "tool" && message.call.toolCallId === toolCallId
          ? { ...message, call: { ...message.call, ...patch } }
          : message,
      ),
    }));
  }

  private appendMessage(message: UIMessage): void {
    this.store.setState((state) => ({
      messages: insertBeforeQueuedMessages(state.messages, message),
    }));
  }

  private upsertBackgroundMessage(job: BackgroundJobView): void {
    this.store.setState((state) => {
      const existing = state.messages.find(
        (message) =>
          message.role === "background" && message.job.jobId === job.jobId,
      );
      if (!existing)
        return {
          messages: insertBeforeQueuedMessages(state.messages, {
            id: uid(),
            role: "background",
            job,
          }),
        };
      return {
        messages: state.messages.map((message) =>
          message.role === "background" && message.job.jobId === job.jobId
            ? { ...message, job }
            : message,
        ),
      };
    });
  }
}

function insertBeforeQueuedMessages(
  messages: UIMessage[],
  message: UIMessage,
): UIMessage[] {
  const queuedIndex = messages.findIndex(
    (item) => item.role === "user" && item.queued !== undefined,
  );
  if (queuedIndex < 0) return [...messages, message];
  return [
    ...messages.slice(0, queuedIndex),
    message,
    ...messages.slice(queuedIndex),
  ];
}

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeToolStatus(
  status: acp.ToolCallStatus | null | undefined,
): ToolCallView["status"] {
  if (status === "completed" || status === "failed") return status;
  return "pending";
}

function extractToolOutput(update: acp.ToolCallUpdate): string | null {
  if (
    typeof update.rawOutput === "object" &&
    update.rawOutput &&
    "output" in update.rawOutput
  ) {
    return String(update.rawOutput.output ?? "");
  }
  const content = update.content?.find(
    (item) => item.type === "content" && item.content.type === "text",
  );
  return content &&
    content.type === "content" &&
    content.content.type === "text"
    ? content.content.text
    : null;
}

function extractToolDiff(update: acp.ToolCallUpdate): ToolDiffView | null {
  const diff = update.content?.find((item) => item.type === "diff");
  if (!diff || diff.type !== "diff") return null;
  return {
    path: diff.path,
    oldText: diff.oldText ?? null,
    newText: diff.newText,
  };
}

function parseBackgroundJob(value: unknown): BackgroundJobView | null {
  if (!value || typeof value !== "object") return null;
  const job = value as Record<string, unknown>;
  const jobId = typeof job.jobId === "string" ? job.jobId : null;
  const kind =
    job.kind === "terminal" || job.kind === "prompt" ? job.kind : null;
  const title = typeof job.title === "string" ? job.title : "background job";
  const status =
    job.status === "running" ||
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "killed" ||
    job.status === "released"
      ? job.status
      : null;
  if (!jobId || !kind || !status) return null;
  return {
    jobId,
    kind,
    title,
    status,
    outputPath: typeof job.outputPath === "string" ? job.outputPath : undefined,
    preview: "",
  };
}

async function readPreview(path: string): Promise<string> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split(/\r?\n/).slice(0, 12).join("\n");
  } catch {
    return "";
  }
}
