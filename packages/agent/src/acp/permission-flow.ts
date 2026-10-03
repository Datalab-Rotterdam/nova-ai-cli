import * as acp from "@agentclientprotocol/sdk";
import type { PermissionPolicy, PolicyDecision } from "../core/policy/policy.js";
import type { ToolAuthorization } from "../core/tool-batch.js";
import type { ToolHost } from "../core/tool-host.js";
import { describeToolCall, previewToolCall } from "../core/tools/describe.js";
import type { ToolDefinition } from "../core/tools/types.js";

/** Option ids of session/request_permission (stable: clients may key on them). */
export const PERMISSION_OPTION = {
  allowOnce: "allow_once",
  allowSession: "allow_session",
  allowAlways: "allow_always",
  reject: "reject_once",
} as const;

export type AuthorizeOptions = {
  client: acp.AgentContext;
  sessionId: string;
  cwd: string;
  host: ToolHost;
  policy: PermissionPolicy;
  signal: AbortSignal;
};

/**
 * The agent's side of every tool call: the session's PermissionPolicy decides,
 * and only calls it cannot decide become a session/request_permission with a
 * readable title, the affected files, a preview (diff or command) and the
 * choices once / this session / always (saving an exact rule) / reject.
 * Decisions the policy made on its own are reported in the tool call's _meta
 * so clients can show why nothing was asked.
 */
export async function authorizeToolCall(
  options: AuthorizeOptions,
  toolCallId: string,
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<ToolAuthorization> {
  const decision = options.policy.decide(tool, args);
  if (decision.decision !== "ask") {
    await reportDecision(options, toolCallId, decision);
    return decision.decision === "allow"
      ? { allowed: true }
      : { allowed: false, reason: "rule" };
  }

  const { title, locations } = describeToolCall(tool.name, args, options.cwd);
  const rule = options.policy.ruleFor(tool, args);
  const preview = await previewToolCall(tool.name, args, options);
  let response: acp.RequestPermissionResponse;
  try {
    response = await options.client.request(
      acp.methods.client.session.requestPermission,
      {
        sessionId: options.sessionId,
        toolCall: {
          toolCallId,
          title,
          kind: tool.kind,
          status: "pending",
          rawInput: args,
          ...(locations.length ? { locations } : {}),
          ...(preview.length ? { content: preview } : {}),
          _meta: { "nova-ai-cli/tool": tool.name, "nova-ai-cli/rule": rule },
        },
        options: [
          { optionId: PERMISSION_OPTION.allowOnce, name: "Allow once", kind: "allow_once" },
          {
            optionId: PERMISSION_OPTION.allowSession,
            name: "Allow for this session",
            kind: "allow_always",
            _meta: { "nova-ai-cli/scope": "session" },
          },
          {
            optionId: PERMISSION_OPTION.allowAlways,
            name: `Always allow ${rule}`,
            kind: "allow_always",
            _meta: { "nova-ai-cli/scope": "always", "nova-ai-cli/rule": rule },
          },
          { optionId: PERMISSION_OPTION.reject, name: "Reject", kind: "reject_once" },
        ],
      },
      { cancellationSignal: options.signal },
    );
  } catch (error) {
    if (options.signal.aborted) throw error;
    // A client that cannot answer must never be read as consent.
    return { allowed: false, reason: "user" };
  }

  if (response.outcome.outcome !== "selected") {
    return { allowed: false, reason: "user" };
  }
  switch (response.outcome.optionId) {
    case PERMISSION_OPTION.allowOnce:
      return { allowed: true };
    case PERMISSION_OPTION.allowSession:
      options.policy.allowForSession(tool, args);
      return { allowed: true };
    case PERMISSION_OPTION.allowAlways:
      try {
        options.policy.allowAlways(tool, args);
      } catch {
        // Saving the rule failed; this call was still approved.
      }
      return { allowed: true };
    default:
      return { allowed: false, reason: "user" };
  }
}

async function reportDecision(
  options: AuthorizeOptions,
  toolCallId: string,
  decision: Exclude<PolicyDecision, { decision: "ask" }>,
): Promise<void> {
  // Read-only calls are the common case and need no explanation.
  if (decision.decision === "allow" && decision.reason === "read-only") return;
  await options.client
    .notify("session/update", {
      sessionId: options.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        _meta: {
          "nova-ai-cli/permission": {
            decision: decision.decision,
            reason: decision.reason,
          },
        },
      },
    })
    .catch(() => {
      // Informational only.
    });
}
