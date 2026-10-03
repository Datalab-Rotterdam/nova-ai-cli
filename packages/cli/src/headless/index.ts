import { resolve } from "node:path";
import { NOVA_NOTIFICATIONS } from "@datalabrotterdam/nova-ai-agent/acp/extensions.js";
import * as acp from "@agentclientprotocol/sdk";
import { NovaAgent } from "@datalabrotterdam/nova-ai-agent/acp/agent.js";
import { clientFromContext } from "@datalabrotterdam/nova-ai-agent/client/context-client.js";
import { startInProcessAgent } from "@datalabrotterdam/nova-ai-agent/client/in-process.js";
import type { PermissionMode } from "@datalabrotterdam/nova-ai-agent/core/policy/settings.js";
import { setWorkspaceTrusted } from "@datalabrotterdam/nova-ai-agent/core/nova-home.js";
import { listStoredSessions, loadStoredSession } from "@datalabrotterdam/nova-ai-agent/core/sessions.js";
import { readWorkspaceMcpConfiguration } from "../tui/settings/workspace-mcp.js";
import {
  HeadlessAcpClient,
  type HeadlessEvent,
  type HeadlessPermissionMode,
} from "./client.js";

export type HeadlessOptions = {
  prompt: string | null;
  cwd: string;
  model: string | null;
  resume: string | null;
  /** Resume the most recent session of the workspace. */
  continueLast: boolean;
  /**
   * text: the answer on stdout. stream-json: JSON Lines events while the turn
   * runs (version-stable, schemaVersion 1). json: one JSON object at the end.
   */
  outputFormat: HeadlessOutputFormat;
  mcp: boolean;
  /** Persistently trust the workspace (its MCP servers and allow rules). */
  trustWorkspace: boolean;
  permissionMode: HeadlessPermissionMode;
  help: boolean;
};

export type HeadlessOutputFormat = "text" | "json" | "stream-json";

type Writable = { write(chunk: string): unknown };

type HeadlessClientLike = {
  capabilities: acp.ClientCapabilities;
  context(): acp.AgentContext;
  close(): Promise<void>;
};

/** The agent methods headless mode reaches over ACP (tests may pass a fake). */
type HeadlessAgentLike = Pick<
  NovaAgent,
  | "initialize"
  | "newSession"
  | "resumeSession"
  | "prompt"
  | "cancel"
  | "closeSession"
  | "setSessionConfigOption"
>;

const AGENT_PERMISSION_MODE: Record<HeadlessPermissionMode, PermissionMode> = {
  "read-only": "default",
  "accept-edits": "acceptEdits",
  "bypass-all": "bypassPermissions",
};

export type HeadlessDependencies = {
  agent?: HeadlessAgentLike;
  stdout?: Writable;
  stderr?: Writable;
  readStdin?: () => Promise<string>;
  clientFactory?: (
    cwd: string,
    permissionMode: HeadlessPermissionMode,
    emit: (event: HeadlessEvent) => void | Promise<void>,
  ) => HeadlessClientLike;
  registerSignals?: boolean;
};

export async function runHeadless(
  args: string[],
  dependencies: HeadlessDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let options: HeadlessOptions;
  try {
    options = parseHeadlessArgs(args, process.cwd());
  } catch (error) {
    const message = errorMessage(error);
    if (args.includes("--json") || args.some((arg) => /^--output-format(=|$)/.test(arg) && !arg.endsWith("=text"))) {
      return writeFailure(true, stdout, stderr, message);
    }
    stderr.write(`${message}\n\n${HEADLESS_HELP}\n`);
    return 1;
  }

  if (options.help) {
    stdout.write(`${HEADLESS_HELP}\n`);
    return 0;
  }

  let prompt = options.prompt;
  if (!prompt) {
    const canReadStdin = dependencies.readStdin || !process.stdin.isTTY;
    if (canReadStdin) {
      prompt = (await (dependencies.readStdin ?? readStdin)()).trim();
    }
  }
  if (!prompt) {
    return writeFailure(
      options.outputFormat !== "text",
      stdout,
      stderr,
      "Headless mode requires a prompt argument or piped stdin.",
    );
  }

  if (options.continueLast) {
    const latest = listStoredSessions(options.cwd)[0];
    if (!latest) {
      return writeFailure(
        options.outputFormat !== "text",
        stdout,
        stderr,
        `No earlier session in ${options.cwd} to continue.`,
      );
    }
    options.resume = latest.sessionId;
  }
  if (options.resume) {
    const stored = loadStoredSession(options.resume);
    if (!stored) {
      return writeFailure(
        options.outputFormat !== "text",
        stdout,
        stderr,
        `Session ${options.resume} not found.`,
      );
    }
    options.cwd = stored.cwd;
  }

  const output = createOutput(options.outputFormat, stdout, stderr);
  const client = (
    dependencies.clientFactory ??
    ((cwd, permissionMode, emit) =>
      new HeadlessAcpClient(cwd, permissionMode, emit))
  )(options.cwd, options.permissionMode, output.event);
  // The same ACP path an editor uses, in-process.
  const connection = startInProcessAgent(
    () => clientFromContext(client.context()),
    (dependencies.agent ?? new NovaAgent()) as NovaAgent,
  );
  const agent = connection.client;

  if (options.trustWorkspace) setWorkspaceTrusted(options.cwd, true);
  const mcpConfiguration = options.mcp
    ? readWorkspaceMcpConfiguration(options.cwd)
    : { servers: [], failures: [] };
  for (const failure of mcpConfiguration.failures) {
    output.write({
      type: "mcp.configuration_error",
      serverName: failure.serverName,
      message: failure.message,
    });
  }

  let sessionId: string | null = null;
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    if (sessionId) void agent.cancel({ sessionId }).catch(() => {});
  };
  if (dependencies.registerSignals !== false)
    process.once("SIGINT", onInterrupt);

  try {
    await agent.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: client.capabilities,
      clientInfo: { name: "nova-ai-cli-headless", version: "1" },
    });
    if (options.resume) {
      await agent.resumeSession({
        sessionId: options.resume,
        cwd: options.cwd,
        mcpServers: mcpConfiguration.servers,
      });
      sessionId = options.resume;
    } else {
      const created = await agent.newSession({
        cwd: options.cwd,
        mcpServers: mcpConfiguration.servers,
      });
      sessionId = created.sessionId;
    }
    // The agent's policy decides; the headless client only answers what is
    // left (see HeadlessAcpClient.requestPermission). Failing to set the mode
    // must stop the run: the agent could otherwise use a remembered, broader
    // mode than the one asked for.
    await agent.setSessionConfigOption({
      sessionId,
      configId: "permission_mode",
      value: AGENT_PERMISSION_MODE[options.permissionMode],
    });

    output.write({
      type: "session.started",
      sessionId,
      cwd: options.cwd,
      model: options.model,
      resumed: Boolean(options.resume),
      permissionMode: options.permissionMode,
    });
    output.write({ type: "message", role: "user", text: prompt });

    const response = await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: prompt }],
      ...(options.model ? { _meta: { "nova-ai-cli/model": options.model } } : {}),
    });
    const exitCode = interrupted
      ? 130
      : response.stopReason === "max_turn_requests"
        ? 3
        : response.stopReason === "cancelled"
          ? 2
          : 0;
    output.finishText();
    output.write({
      type: "result",
      sessionId,
      stopReason: response.stopReason,
      exitCode,
    });
    return exitCode;
  } catch (error) {
    output.finishText();
    output.error(errorMessage(error));
    return 1;
  } finally {
    if (dependencies.registerSignals !== false)
      process.removeListener("SIGINT", onInterrupt);
    if (sessionId) await agent.closeSession({ sessionId }).catch(() => ({}));
    await connection.close().catch(() => {});
    await client.close().catch(() => {});
  }
}

export function parseHeadlessArgs(
  args: string[],
  defaultCwd: string,
): HeadlessOptions {
  const options: HeadlessOptions = {
    prompt: null,
    cwd: resolve(defaultCwd),
    model: null,
    resume: null,
    continueLast: false,
    outputFormat: "text",
    mcp: true,
    trustWorkspace: false,
    permissionMode: "read-only",
    help: false,
  };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--json") options.outputFormat = "stream-json";
    else if (arg === "--continue" || arg === "-c") options.continueLast = true;
    else if (arg === "--output-format")
      options.outputFormat = parseOutputFormat(takeValue(args, ++index, arg));
    else if (arg.startsWith("--output-format="))
      options.outputFormat = parseOutputFormat(arg.slice("--output-format=".length));
    // -p/--print selects this mode; a following non-option argument is the prompt.
    else if (arg === "--print" || arg === "-p") {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        options.prompt = next;
        index++;
      }
    }
    else if (arg === "--no-mcp") options.mcp = false;
    else if (arg === "--trust-workspace") options.trustWorkspace = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--prompt")
      options.prompt = takeValue(args, ++index, arg);
    else if (arg.startsWith("--prompt="))
      options.prompt = arg.slice("--prompt=".length);
    else if (arg === "--cwd")
      options.cwd = resolve(takeValue(args, ++index, arg));
    else if (arg.startsWith("--cwd="))
      options.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg === "--model") options.model = takeValue(args, ++index, arg);
    else if (arg.startsWith("--model="))
      options.model = arg.slice("--model=".length);
    else if (arg === "--resume") options.resume = takeValue(args, ++index, arg);
    else if (arg.startsWith("--resume="))
      options.resume = arg.slice("--resume=".length);
    else if (arg === "--permission-mode")
      options.permissionMode = parsePermissionMode(
        takeValue(args, ++index, arg),
      );
    else if (arg.startsWith("--permission-mode="))
      options.permissionMode = parsePermissionMode(
        arg.slice("--permission-mode=".length),
      );
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }

  if (options.prompt && positional.length) {
    throw new Error(
      "Provide the prompt either with --prompt or positionally, not both.",
    );
  }
  if (!options.prompt && positional.length)
    options.prompt = positional.join(" ");
  if (options.continueLast && options.resume) {
    throw new Error("Use either --continue or --resume, not both.");
  }
  if (options.prompt !== null && !options.prompt.trim()) {
    throw new Error("Prompt cannot be empty.");
  }
  return options;
}

function createOutput(format: HeadlessOutputFormat, stdout: Writable, stderr: Writable) {
  let wroteText = false;
  // json: everything is collected into one object written by finish().
  const summary: { text: string; tools: Array<Record<string, unknown>>; permissions: Array<Record<string, unknown>> } = {
    text: "",
    tools: [],
    permissions: [],
  };
  const write = (record: Record<string, unknown>) => {
    if (format === "stream-json") {
      stdout.write(`${JSON.stringify({ schemaVersion: 1, ...record })}\n`);
      return;
    }
    if (format !== "json") return;
    if (record.type === "result") {
      stdout.write(
        `${JSON.stringify({ schemaVersion: 1, ...record, text: summary.text, tools: summary.tools, permissions: summary.permissions })}\n`,
      );
    } else if (record.type === "error") {
      stdout.write(`${JSON.stringify({ schemaVersion: 1, ...record })}\n`);
    } else if (record.type === "message.delta" && record.role === "assistant") {
      summary.text += String(record.text ?? "");
    } else if (record.type === "tool.finished") {
      summary.tools.push({ toolCallId: record.toolCallId, status: record.status });
    } else if (record.type === "permission") {
      summary.permissions.push(record);
    }
  };
  return {
    write,
    event: async (event: HeadlessEvent) => {
      if (event.type === "permission") {
        write(event);
        return;
      }
      const record = notificationRecord(event.method, event.params);
      if (record) write(record);
      if (format === "text" && record?.type === "message.delta" && record.role === "assistant") {
        stdout.write(String(record.text ?? ""));
        wroteText = true;
      }
    },
    finishText: () => {
      if (format === "text" && wroteText) {
        stdout.write("\n");
        wroteText = false;
      }
    },
    error: (message: string) => {
      if (format === "text") stderr.write(`${message}\n`);
      else write({ type: "error", message });
    },
  };
}

function notificationRecord(
  method: string,
  params: unknown,
): Record<string, unknown> | null {
  if (method === NOVA_NOTIFICATIONS.backgroundUpdate) {
    return { type: "background.update", ...(toRecord(params) ?? {}) };
  }
  if (method === NOVA_NOTIFICATIONS.queueChanged) {
    return { type: "queue.changed", ...(toRecord(params) ?? {}) };
  }
  if (method !== "session/update") {
    return { type: "acp.notification", method, params };
  }
  const root = toRecord(params);
  const update = toRecord(root?.update);
  const sessionId = root?.sessionId;
  switch (update?.sessionUpdate) {
    case "agent_message_chunk":
      return {
        type: "message.delta",
        sessionId,
        role: "assistant",
        text: textContent(update.content),
      };
    case "user_message_chunk":
      return {
        type: "message.delta",
        sessionId,
        role: "user",
        text: textContent(update.content),
      };
    case "agent_thought_chunk":
      return {
        type: "thought",
        sessionId,
        text: textContent(update.content),
      };
    case "tool_call": {
      const toolName = toRecord(update._meta)?.["nova-ai-cli/tool"];
      return {
        type: "tool.started",
        sessionId,
        toolCallId: update.toolCallId,
        name: typeof toolName === "string" ? toolName : update.title,
        title: update.title,
        kind: update.kind,
        input: update.rawInput,
      };
    }
    case "tool_call_update":
      return {
        type:
          update.status === "completed" || update.status === "failed"
            ? "tool.finished"
            : "tool.updated",
        sessionId,
        toolCallId: update.toolCallId,
        status: update.status,
        output: toRecord(update.rawOutput)?.output,
        content: update.content,
      };
    case "current_mode_update":
      return {
        type: "mode.changed",
        sessionId,
        mode: update.currentModeId,
      };
    default:
      return null;
  }
}

function textContent(value: unknown): string {
  const content = toRecord(value);
  return content?.type === "text" && typeof content.text === "string"
    ? content.text
    : "";
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseOutputFormat(value: string): HeadlessOutputFormat {
  if (value === "text" || value === "json" || value === "stream-json") return value;
  throw new Error(`Unknown output format: ${value}. Expected text, json, or stream-json.`);
}

function parsePermissionMode(value: string): HeadlessPermissionMode {
  if (
    value === "read-only" ||
    value === "accept-edits" ||
    value === "bypass-all"
  ) {
    return value;
  }
  throw new Error(
    `Unknown permission mode: ${value}. Expected read-only, accept-edits, or bypass-all.`,
  );
}

function takeValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function writeFailure(
  json: boolean,
  stdout: Writable,
  stderr: Writable,
  message: string,
): number {
  if (json)
    stdout.write(
      `${JSON.stringify({ schemaVersion: 1, type: "error", message })}\n`,
    );
  else stderr.write(`${message}\n`);
  return 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const HEADLESS_HELP = `Usage: nova-ai -p [options] [prompt]

Run one Nova agent request without the interactive terminal UI. The prompt
can also be piped on stdin.

Options:
  -p, --print [prompt]             Run headless (the prompt may follow)
      --output-format <format>     text (default), json (one object at the end)
                                   or stream-json (JSON Lines while it runs)
      --json                       Same as --output-format stream-json
      --cwd <path>                 Workspace directory (default: current directory)
      --model <id>                 Override the configured model
      --resume <session-id>        Continue a persisted session
  -c, --continue                   Continue the most recent session of the workspace
      --no-mcp                     Ignore workspace MCP configuration
      --trust-workspace            Trust this workspace (remembered): start the MCP
                                   servers and apply the allow rules it declares
      --permission-mode <mode>     read-only (default), accept-edits, or bypass-all
  -h, --help                       Show this help

Exit codes: 0 success, 1 configuration/runtime error, 2 cancelled,
3 tool-turn safety limit, 130 interrupted.`;

export default runHeadless;
