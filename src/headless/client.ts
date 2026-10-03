import type * as acp from "@agentclientprotocol/sdk";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  choosePermissionOption,
  TuiAcpClient,
} from "../tui/session/tui-acp-client.js";
import { createStore } from "../tui/state/store.js";
import type { UIState } from "../tui/state/types.js";

export type HeadlessPermissionMode =
  "read-only" | "accept-edits" | "bypass-all";

export type HeadlessEvent =
  | {
      type: "permission";
      toolCallId: string;
      toolName: string;
      decision: "allow" | "reject";
      source: "rule" | HeadlessPermissionMode;
    }
  | { type: "notification"; method: string; params: unknown };

export class HeadlessAcpClient {
  readonly capabilities = {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
  } satisfies acp.ClientCapabilities;

  private readonly base: TuiAcpClient;
  private readonly baseContext: acp.AgentContext;
  private readonly toolNames = new Map<string, string>();

  constructor(
    cwd: string,
    private readonly permissionMode: HeadlessPermissionMode,
    private readonly emit: (event: HeadlessEvent) => void | Promise<void>,
  ) {
    const store = createStore<UIState>({
      messages: [],
      plan: [],
      pendingPermission: null,
      pendingQuestion: null,
      inputHistory: [],
      busy: false,
      mode: "chat",
      permissionMode: "ask",
      interactionMode: "agent",
      sessionId: "headless",
      cwd,
      statusLine: null,
      queuedCount: 0,
      contextUsage: null,
      updateAvailable: null,
    });
    this.base = new TuiAcpClient(store, cwd);
    this.baseContext = this.base.context();
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

  async close(): Promise<void> {
    await this.base.releaseAllTerminals();
  }

  private async handleRequest(
    method: string,
    params?: unknown,
    options?: acp.SendRequestOptions,
  ): Promise<unknown> {
    options?.cancellationSignal?.throwIfAborted();
    if (method === "session/request_permission") {
      return this.requestPermission(params as RequestPermissionRequest);
    }
    if (method === "elicitation/create") {
      return { action: "decline" };
    }
    return this.baseContext.request(method, params, options);
  }

  private async handleNotification(
    method: string,
    params?: unknown,
  ): Promise<void> {
    await this.emit({ type: "notification", method, params });
    if (method === "session/update") await this.reportAgentDecision(params);
    await this.baseContext.notify(method, params);
  }

  /**
   * The agent's policy already applied rules and the mode (set from
   * --permission-mode); what still reaches us needs a person, and there is
   * none: only bypass-all approves it.
   */
  private async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const toolName = this.toolName(params.toolCall);
    const allow = this.permissionMode === "bypass-all";
    const optionId =
      choosePermissionOption(params.options, allow, "once") ??
      (allow ? "allow_once" : "reject_once");
    await this.emit({
      type: "permission",
      toolCallId: params.toolCall.toolCallId,
      toolName,
      decision: allow ? "allow" : "reject",
      source: this.permissionMode,
    });
    return { outcome: { outcome: "selected", optionId } };
  }

  /** Reports decisions the agent's policy made without asking. */
  private async reportAgentDecision(params: unknown): Promise<void> {
    const update = (params as { update?: Record<string, unknown> })?.update;
    if (!update) return;
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : null;
    if (!toolCallId) return;
    if (update.sessionUpdate === "tool_call") {
      this.toolNames.set(toolCallId, this.toolName(update as { title?: string; _meta?: Record<string, unknown> }));
      return;
    }
    const permission = (update._meta as Record<string, unknown> | undefined)?.[
      "nova-ai-cli/permission"
    ] as { decision?: string; reason?: string } | undefined;
    if (update.sessionUpdate !== "tool_call_update" || !permission) return;
    await this.emit({
      type: "permission",
      toolCallId,
      toolName: this.toolNames.get(toolCallId) ?? "tool",
      decision: permission.decision === "allow" ? "allow" : "reject",
      source: permission.reason === "mode" ? this.permissionMode : "rule",
    });
  }

  private toolName(call: { title?: string | null; _meta?: Record<string, unknown> | null }): string {
    const fromMeta = call._meta?.["nova-ai-cli/tool"];
    return typeof fromMeta === "string" ? fromMeta : (call.title ?? "tool");
  }

}
