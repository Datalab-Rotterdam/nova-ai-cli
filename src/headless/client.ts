import type * as acp from "@agentclientprotocol/sdk";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  evaluatePermissionRules,
  type PermissionDecision,
} from "../tui/settings/permission-rules.js";
import { readWorkspaceSettings } from "../tui/settings/workspace-settings.js";
import { TuiAcpClient } from "../tui/session/tui-acp-client.js";
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

const EDIT_TOOL_NAMES = new Set(["write_file", "edit_file", "save_memory"]);

export class HeadlessAcpClient {
  readonly capabilities = {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
  } satisfies acp.ClientCapabilities;

  private readonly base: TuiAcpClient;
  private readonly baseContext: acp.AgentContext;
  private readonly permissionRules;

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
    this.permissionRules = readWorkspaceSettings(cwd).permissions;
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
    await this.baseContext.notify(method, params);
  }

  private async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const toolName = params.toolCall.title ?? "tool";
    const args = toRecord(params.toolCall.rawInput);
    const ruleDecision = evaluatePermissionRules(
      this.permissionRules,
      toolName,
      args,
    );
    const { allow, source } = this.permissionDecision(ruleDecision, toolName);
    await this.emit({
      type: "permission",
      toolCallId: params.toolCall.toolCallId,
      toolName,
      decision: allow ? "allow" : "reject",
      source,
    });
    return {
      outcome: {
        outcome: "selected",
        optionId: allow ? "allow" : "reject",
      },
    };
  }

  private permissionDecision(
    ruleDecision: PermissionDecision,
    toolName: string,
  ): { allow: boolean; source: "rule" | HeadlessPermissionMode } {
    if (ruleDecision === "deny") return { allow: false, source: "rule" };
    if (ruleDecision === "allow") return { allow: true, source: "rule" };
    if (this.permissionMode === "bypass-all") {
      return { allow: true, source: "bypass-all" };
    }
    if (
      this.permissionMode === "accept-edits" &&
      EDIT_TOOL_NAMES.has(toolName)
    ) {
      return { allow: true, source: "accept-edits" };
    }
    return { allow: false, source: this.permissionMode };
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
