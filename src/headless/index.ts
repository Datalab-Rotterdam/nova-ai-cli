import { resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { NovaAgent } from "../acp/agent.js";
import { loadStoredSession } from "../acp/sessions.js";
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
  json: boolean;
  mcp: boolean;
  permissionMode: HeadlessPermissionMode;
  help: boolean;
};

type Writable = { write(chunk: string): unknown };

type HeadlessClientLike = {
  capabilities: acp.ClientCapabilities;
  context(): acp.AgentContext;
  close(): Promise<void>;
};

type HeadlessAgentLike = Pick<
  NovaAgent,
  | "initialize"
  | "newSession"
  | "resumeSession"
  | "prompt"
  | "cancel"
  | "closeSession"
>;

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
    if (args.includes("--json")) {
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
      options.json,
      stdout,
      stderr,
      "Headless mode requires a prompt argument or piped stdin.",
    );
  }

  if (options.resume) {
    const stored = loadStoredSession(options.resume);
    if (!stored) {
      return writeFailure(
        options.json,
        stdout,
        stderr,
        `Session ${options.resume} not found.`,
      );
    }
    options.cwd = stored.cwd;
  }

  const output = createOutput(options.json, stdout, stderr);
  const agent = dependencies.agent ?? new NovaAgent();
  const client = (
    dependencies.clientFactory ??
    ((cwd, permissionMode, emit) =>
      new HeadlessAcpClient(cwd, permissionMode, emit))
  )(options.cwd, options.permissionMode, output.event);
  const context = client.context();
  agent.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: client.capabilities,
  });

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
    if (sessionId) agent.cancel({ sessionId });
  };
  if (dependencies.registerSignals !== false)
    process.once("SIGINT", onInterrupt);

  try {
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

    output.write({
      type: "session.started",
      sessionId,
      cwd: options.cwd,
      model: options.model,
      resumed: Boolean(options.resume),
      permissionMode: options.permissionMode,
    });
    output.write({ type: "message", role: "user", text: prompt });

    const response = await agent.prompt(
      {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
        ...(options.model
          ? { _meta: { "nova-ai-cli/model": options.model } }
          : {}),
      },
      context,
    );
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
    await client.close().catch(() => {});
    if (sessionId) await agent.closeSession({ sessionId }).catch(() => ({}));
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
    json: false,
    mcp: true,
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
    if (arg === "--json") options.json = true;
    else if (arg === "--no-mcp") options.mcp = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--prompt" || arg === "-p")
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
  if (options.prompt !== null && !options.prompt.trim()) {
    throw new Error("Prompt cannot be empty.");
  }
  return options;
}

function createOutput(json: boolean, stdout: Writable, stderr: Writable) {
  let wroteText = false;
  const write = (record: Record<string, unknown>) => {
    if (json)
      stdout.write(`${JSON.stringify({ schemaVersion: 1, ...record })}\n`);
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
      if (!json && record?.type === "message.delta") {
        stdout.write(String(record.text ?? ""));
        wroteText = true;
      }
    },
    finishText: () => {
      if (!json && wroteText) {
        stdout.write("\n");
        wroteText = false;
      }
    },
    error: (message: string) => {
      if (json) write({ type: "error", message });
      else stderr.write(`${message}\n`);
    },
  };
}

function notificationRecord(
  method: string,
  params: unknown,
): Record<string, unknown> | null {
  if (method === "background/update") {
    return { type: "background.update", ...(toRecord(params) ?? {}) };
  }
  if (method === "queue/changed") {
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
    case "tool_call":
      return {
        type: "tool.started",
        sessionId,
        toolCallId: update.toolCallId,
        name: update.title,
        kind: update.kind,
        input: update.rawInput,
      };
    case "tool_call_update":
      return {
        type: "tool.finished",
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

export const HEADLESS_HELP = `Usage: nova-ai --headless [options] [prompt]

Run one Nova agent request without the interactive terminal UI.

Options:
  -p, --prompt <text>              Prompt text (or pipe it over stdin)
      --json                       Write version-stable JSON Lines events
      --cwd <path>                 Workspace directory (default: current directory)
      --model <id>                 Override the configured model
      --resume <session-id>        Continue a persisted session
      --no-mcp                     Ignore workspace MCP configuration
      --permission-mode <mode>     read-only (default), accept-edits, or bypass-all
  -h, --help                       Show this help

Exit codes: 0 success, 1 configuration/runtime error, 2 cancelled,
3 tool-turn safety limit, 130 interrupted.`;

export default runHeadless;
