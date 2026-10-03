import * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent } from "../core/agent-events.js";
import type { BackgroundJobSummary } from "../core/background.js";
import type { McpConnection, McpConnectionFailure } from "../core/mcp.js";
import type { SkillDefinition } from "../core/skills.js";
import type { ToolDefinition } from "../core/tools/types.js";

export async function notifyPlanUpdate(
  client: acp.AgentContext,
  sessionId: string,
  entries: acp.PlanEntry[],
): Promise<void> {
  await client
    .notify("session/update", {
      sessionId,
      update: { sessionUpdate: "plan", entries },
    })
    .catch(() => {
      // Plan state is presentation-only; a disconnected client must not stop
      // the agent's actual work or turn a successful checklist update into a
      // failed tool call.
    });
}

export async function emitToAcp(
  client: acp.AgentContext,
  sessionId: string,
  event: AgentEvent,
): Promise<void> {
  switch (event.type) {
    case "text":
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: event.text },
        },
      });
      return;
    case "context_compacted":
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: {
            type: "text",
            text: `Context compacted automatically: summarized ${event.removedMessages} older messages and kept ${event.keptMessages} recent messages.`,
          },
        },
      });
      return;
    case "context_compaction_failed":
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: {
            type: "text",
            text: `Automatic context compaction failed (${event.reason}); continuing without it.`,
          },
        },
      });
      return;
    case "tool_pending":
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: event.toolCallId,
          title: event.name,
          kind: event.kind,
          status: "pending",
          rawInput: event.args,
          _meta: { "nova-ai-cli/mutating": event.mutating },
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
          content: [
            { type: "content", content: { type: "text", text: event.output } },
            ...(event.diff
              ? [
                  {
                    type: "diff" as const,
                    path: event.diff.path,
                    oldText: event.diff.oldText,
                    newText: event.diff.newText,
                  },
                ]
              : []),
          ],
          rawOutput: { output: event.output },
        },
      });
      return;
    case "end_turn":
    case "error":
      return;
  }
}

export async function emitBackgroundUpdate(
  client: acp.AgentContext,
  event: string,
  job: BackgroundJobSummary,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await client.notify("background/update", { event, job, ...extra });
}

export async function requestAcpPermission(
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
        kind: tool.kind,
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

  return (
    response.outcome.outcome === "selected" &&
    response.outcome.optionId === "allow"
  );
}

export function sessionStatusMeta(
  servers: acp.McpServer[],
  connections: McpConnection[],
  failures: McpConnectionFailure[],
  skills: SkillDefinition[],
): Record<string, unknown> {
  return {
    "nova-ai-cli/mcp": {
      configured: servers.map((server) => ({
        name: server.name,
        transport: "type" in server ? server.type : "stdio",
      })),
      connected: connections.map((connection) => connection.serverName),
      failures,
    },
    "nova-ai-cli/skills": skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      path: skill.path,
    })),
  };
}
