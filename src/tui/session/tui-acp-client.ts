import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import type * as acp from "@agentclientprotocol/sdk";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
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
import { addAlwaysAllowedTool, readWorkspaceSettings } from "../settings/workspace-settings.js";
import type { Store } from "../state/store.js";
import type { BackgroundJobView, ToolCallView, UIMessage, UIState } from "../state/types.js";

const DEFAULT_OUTPUT_LIMIT = 100_000;
const AUTO_EDIT_TOOL_NAMES = new Set(["write_file"]);

let nextMessageId = 0;
function uid(): string {
  nextMessageId += 1;
  return `m${nextMessageId}`;
}

type TerminalRecord = {
  child: ChildProcessWithoutNullStreams;
  command: string;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
  exitPromise: Promise<WaitForTerminalExitResponse>;
};

export class TuiAcpClient {
  readonly capabilities = {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
  } satisfies acp.ClientCapabilities;

  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly allowedForSession = new Set<string>();
  private readonly alwaysAllowedTools: Set<string>;
  private streamingMessageId: string | null = null;
  private nextTerminalId = 0;

  constructor(
    private readonly store: Store<UIState>,
    private readonly cwd: string,
    private readonly onBackgroundLifecycle?: (event: string, job: BackgroundJobView) => void | Promise<void>,
  ) {
    this.alwaysAllowedTools = new Set(readWorkspaceSettings(cwd).allowedTools ?? []);
  }

  context(): acp.AgentContext {
    return {
      request: (method: string, params?: unknown, options?: acp.SendRequestOptions) =>
        this.handleRequest(method, params, options),
      notify: (method: string, params?: unknown) => this.handleNotification(method, params),
    } as unknown as acp.AgentContext;
  }

  resetStreaming(): void {
    if (this.streamingMessageId) {
      const id = this.streamingMessageId;
      this.store.setState((state) => ({
        messages: state.messages.map((message) =>
          message.id === id && message.role === "assistant" ? { ...message, streaming: false } : message,
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

  releaseAllTerminals(): void {
    for (const terminalId of [...this.terminals.keys()]) {
      void this.releaseTerminal({ sessionId: this.store.getState().sessionId, terminalId });
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    let content = await readFile(params.path, "utf8");
    if (params.line || params.limit) {
      const start = Math.max((params.line ?? 1) - 1, 0);
      const end = params.limit ? start + params.limit : undefined;
      content = content.split(/\r?\n/).slice(start, end).join("\n");
    }
    return { content };
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<void> {
    await writeFile(params.path, params.content, "utf8");
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = `tui-${++this.nextTerminalId}`;
    const outputByteLimit = params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT;
    const env = { ...process.env };
    for (const variable of params.env ?? []) env[variable.name] = variable.value;

    const child = params.args?.length
      ? spawn(params.command, params.args, { cwd: params.cwd ?? this.cwd, env })
      : spawn(params.command, { cwd: params.cwd ?? this.cwd, env, shell: true });

    const record: TerminalRecord = {
      child,
      command: params.command,
      output: "",
      truncated: false,
      outputByteLimit,
      exitStatus: null,
      exitPromise: Promise.resolve({}),
    };

    const append = (chunk: Buffer) => {
      record.output += chunk.toString("utf8");
      if (record.output.length > record.outputByteLimit) {
        record.output = record.output.slice(record.output.length - record.outputByteLimit);
        record.truncated = true;
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    record.exitPromise = new Promise((resolve) => {
      child.on("error", (err) => {
        record.output += `\n${err.message}`;
        record.exitStatus = { exitCode: null, signal: "error" };
        resolve(record.exitStatus);
      });
      child.on("close", (exitCode, signal) => {
        record.exitStatus = { exitCode, signal };
        resolve(record.exitStatus);
      });
    });

    this.terminals.set(terminalId, record);
    return { terminalId };
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const record = this.requireTerminal(params.terminalId);
    return {
      output: record.output,
      truncated: record.truncated,
      exitStatus: record.exitStatus,
    };
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    return this.requireTerminal(params.terminalId).exitPromise;
  }

  async killTerminal(params: KillTerminalRequest): Promise<void> {
    const record = this.requireTerminal(params.terminalId);
    if (!record.exitStatus) record.child.kill();
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<void> {
    const record = this.terminals.get(params.terminalId);
    if (!record) return;
    if (!record.exitStatus) record.child.kill();
    this.terminals.delete(params.terminalId);
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const permissionMode = this.store.getState().permissionMode;
    const toolName = params.toolCall.title ?? "tool";
    const args = toRecord(params.toolCall.rawInput);
    if (permissionMode === "bypassAll") return selected("allow");
    if (permissionMode === "acceptEdits" && AUTO_EDIT_TOOL_NAMES.has(toolName)) return selected("allow");
    if (this.alwaysAllowedTools.has(toolName)) return selected("allow");

    const key = `${toolName}:${JSON.stringify(args)}`;
    if (this.allowedForSession.has(key)) return selected("allow");

    return new Promise<RequestPermissionResponse>((resolve) => {
      this.store.setState({
        pendingPermission: {
          toolCallId: params.toolCall.toolCallId,
          toolName,
          args,
          resolve: (allow, scope) => {
            if (allow && scope === "session") this.allowedForSession.add(key);
            if (allow && scope === "always") {
              this.alwaysAllowedTools.add(toolName);
              addAlwaysAllowedTool(this.cwd, toolName);
            }
            this.store.setState({ pendingPermission: null });
            resolve(allow ? selected("allow") : selected("reject"));
          },
        },
      });
    });
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        return;
      case "agent_message_chunk":
        if (update.content.type === "text") this.appendStreamingText(update.content.text);
        return;
      case "tool_call":
        this.streamingMessageId = null;
        this.appendMessage({
          id: uid(),
          role: "tool",
          call: {
            toolCallId: update.toolCallId,
            name: update.title,
            mutating: update.kind !== "read" && update.kind !== "search",
            args: toRecord(update.rawInput),
            status: normalizeToolStatus(update.status),
            output: null,
          },
        });
        return;
      case "tool_call_update":
        this.patchToolCall(update.toolCallId, {
          status: normalizeToolStatus(update.status),
          output: extractToolOutput(update),
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

    const preview = job.outputPath && event !== "started" ? await readPreview(job.outputPath) : "";
    this.upsertBackgroundMessage({ ...job, preview });
    this.store.setState({ statusLine: `Background ${event}: ${job.title}` });
    await this.onBackgroundLifecycle?.(event, job);
  }

  private async handleRequest(method: string, params?: unknown, options?: acp.SendRequestOptions): Promise<unknown> {
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
      default:
        throw new Error(`Unsupported ACP client request: ${method}`);
    }
  }

  private async handleNotification(method: string, params?: unknown): Promise<void> {
    switch (method) {
      case "session/update":
        return this.sessionUpdate(params as SessionNotification);
      case "background/update":
        return this.backgroundUpdate(params);
      default:
        return;
    }
  }

  private requireTerminal(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (!record) throw new Error(`Terminal ${terminalId} not found`);
    return record;
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

  private patchToolCall(toolCallId: string, patch: Partial<ToolCallView>): void {
    this.store.setState((state) => ({
      messages: state.messages.map((message) =>
        message.role === "tool" && message.call.toolCallId === toolCallId
          ? { ...message, call: { ...message.call, ...patch } }
          : message,
      ),
    }));
  }

  private appendMessage(message: UIMessage): void {
    this.store.setState((state) => ({ messages: [...state.messages, message] }));
  }

  private upsertBackgroundMessage(job: BackgroundJobView): void {
    this.store.setState((state) => {
      const existing = state.messages.find(
        (message) => message.role === "background" && message.job.jobId === job.jobId,
      );
      if (!existing) return { messages: [...state.messages, { id: uid(), role: "background", job }] };
      return {
        messages: state.messages.map((message) =>
          message.role === "background" && message.job.jobId === job.jobId ? { ...message, job } : message,
        ),
      };
    });
  }
}

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeToolStatus(status: acp.ToolCallStatus | null | undefined): ToolCallView["status"] {
  if (status === "completed" || status === "failed") return status;
  return "pending";
}

function extractToolOutput(update: acp.ToolCallUpdate): string | null {
  if (typeof update.rawOutput === "object" && update.rawOutput && "output" in update.rawOutput) {
    return String(update.rawOutput.output ?? "");
  }
  const content = update.content?.find((item) => item.type === "content" && item.content.type === "text");
  return content && content.type === "content" && content.content.type === "text" ? content.content.text : null;
}

function parseBackgroundJob(value: unknown): BackgroundJobView | null {
  if (!value || typeof value !== "object") return null;
  const job = value as Record<string, unknown>;
  const jobId = typeof job.jobId === "string" ? job.jobId : null;
  const kind = job.kind === "terminal" || job.kind === "prompt" ? job.kind : null;
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
