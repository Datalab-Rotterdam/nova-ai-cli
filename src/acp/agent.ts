import * as acp from "@agentclientprotocol/sdk";
import { NovaAI, NovaAIError, type ChatMessage } from "@datalabrotterdam/nova-sdk";
import { runBrowserAuth } from "./auth-server.js";
import { readCredentials } from "./credentials.js";
import { closeMcpConnections, connectMcpServers, listMcpTools, type McpConnection } from "./mcp.js";
import { appendSessionTurn, deriveTitle, listStoredSessions, loadStoredSession } from "./sessions.js";
import {
  availableTools,
  buildToolsSystemPrompt,
  extractToolCall,
  hasPendingFence,
  requestPermissionIfNeeded,
  sendToolCallPending,
  sendToolCallUpdate,
} from "./tools/index.js";
import type { ToolDefinition } from "./tools/types.js";

const AUTH_METHOD_ID = "nova-api-key";
const MAX_TOOL_ROUNDS = 10;

type Session = {
  pendingPrompt: AbortController | null;
  cwd: string;
  history: ChatMessage[];
  title: string | null;
  mcpConnections: McpConnection[];
  mcpTools: ToolDefinition[];
};

export class NovaAgent {
  private readonly sessions = new Map<string, Session>();
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
    this.sessions.set(sessionId, {
      pendingPrompt: null,
      cwd: params.cwd,
      history: [],
      title: null,
      mcpConnections,
      mcpTools,
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
    this.sessions.set(params.sessionId, {
      pendingPrompt: null,
      cwd: params.cwd,
      history: stored.messages,
      title: stored.title,
      mcpConnections,
      mcpTools,
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
    const model = credentials.defaultModel ?? process.env.NOVA_MODEL;
    if (!model) {
      throw new Error(
        "No Nova model configured. Re-run authentication or set NOVA_MODEL.",
      );
    }

    const tools = [...availableTools(this.clientCapabilities), ...session.mcpTools];
    const findSessionTool = (name: string) => tools.find((tool) => tool.name === name);
    const systemPrompt = buildToolsSystemPrompt(tools, session.cwd);

    const userMessage: ChatMessage = { role: "user", content: contentBlocksToText(params.prompt) };
    session.history.push(userMessage);
    const turnMessages: ChatMessage[] = [userMessage];

    const messages: ChatMessage[] = [
      ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
      ...session.history,
    ];
    const pushTurn = (message: ChatMessage) => {
      session.history.push(message);
      messages.push(message);
      turnMessages.push(message);
    };

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (abortController.signal.aborted) {
          return { stopReason: "cancelled" };
        }

        let buffer = "";
        let flushed = 0;

        for await (const event of novaClient.chat.completions.stream(
          { model, messages },
          { signal: abortController.signal },
        )) {
          if (event.type !== "chunk") continue;

          const text = event.data.choices?.[0]?.delta?.content;
          if (typeof text !== "string" || text.length === 0) continue;

          buffer += text;

          if (!hasPendingFence(buffer)) {
            const toFlush = buffer.slice(flushed);
            if (toFlush) {
              await client.notify("session/update", {
                sessionId: params.sessionId,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: toFlush } },
              });
              flushed = buffer.length;
            }
          }
        }

        const toolCall = extractToolCall(buffer);
        if (!toolCall) {
          const remaining = buffer.slice(flushed);
          if (remaining) {
            await client.notify("session/update", {
              sessionId: params.sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: remaining } },
            });
          }
          pushTurn({ role: "assistant", content: buffer });
          return { stopReason: "end_turn" };
        }

        const tool = findSessionTool(toolCall.name);
        const toolCallId = crypto.randomUUID();
        const toolCtx = { client, sessionId: params.sessionId, signal: abortController.signal };

        pushTurn({ role: "assistant", content: buffer });

        if (!tool) {
          pushTurn({ role: "user", content: `Tool "${toolCall.name}" is not available.` });
          continue;
        }

        await sendToolCallPending(toolCtx, toolCallId, tool, toolCall.args);

        const allowed = await requestPermissionIfNeeded(toolCtx, toolCallId, tool, toolCall.args);
        if (!allowed) {
          await sendToolCallUpdate(toolCtx, toolCallId, "failed", "Permission denied by user.");
          pushTurn({ role: "user", content: "Tool call rejected by user." });
          continue;
        }

        const result = await tool.execute(toolCtx, toolCall.args);
        if ("error" in result) {
          await sendToolCallUpdate(toolCtx, toolCallId, "failed", result.error);
          pushTurn({ role: "user", content: `Tool error: ${result.error}` });
        } else {
          await sendToolCallUpdate(toolCtx, toolCallId, "completed", result.output);
          pushTurn({ role: "user", content: `Tool result: ${result.output}` });
        }
      }

      return { stopReason: "max_turn_requests" };
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
      session.title ??= deriveTitle(session.history);
      appendSessionTurn(params.sessionId, { cwd: session.cwd, title: session.title }, turnMessages);
    }
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
