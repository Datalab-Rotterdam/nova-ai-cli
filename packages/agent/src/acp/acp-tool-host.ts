import * as acp from "@agentclientprotocol/sdk";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  type RunCommandOptions,
  type RunCommandResult,
  type ToolHost,
} from "../core/tool-host.js";

/** Output a client keeps per terminal (bytes); older output is dropped. */
const TERMINAL_OUTPUT_LIMIT = 100_000;
/** How long to wait for an exit status after terminal/kill. */
const KILL_EXIT_GRACE_MS = 5_000;
import type {
  UserInputRequest,
  UserInputResponse,
} from "../core/user-questions.js";
import {
  fromElicitationResponse,
  toElicitationRequest,
} from "./user-questions.js";

export type AcpToolHostOptions = {
  /** Wait after terminal/kill before giving up on the exit (tests shorten it). */
  killGraceMs?: number;
  /** Time limit for commands that set none (the session's setting). */
  defaultTimeoutMs?: number;
};

export class AcpToolHost implements ToolHost {
  private readonly killGraceMs: number;
  private readonly defaultTimeoutMs: number;

  constructor(
    private readonly client: acp.AgentContext,
    private readonly sessionId: string,
    options: AcpToolHostOptions = {},
  ) {
    this.killGraceMs = options.killGraceMs ?? KILL_EXIT_GRACE_MS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  async readTextFile(path: string, signal: AbortSignal): Promise<string> {
    const result = await this.client.request(
      acp.methods.client.fs.readTextFile,
      { sessionId: this.sessionId, path },
      { cancellationSignal: signal },
    );
    return result.content;
  }

  async writeTextFile(
    path: string,
    content: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.client.request(
      acp.methods.client.fs.writeTextFile,
      { sessionId: this.sessionId, path, content },
      { cancellationSignal: signal },
    );
  }

  /**
   * Runs a command in a client terminal: in the session's workspace, with an
   * output limit, attached live to its tool call, and stopped with
   * terminal/kill when it outlives its timeout or the turn is cancelled. After
   * a kill the wait for the exit status is bounded, so a client that never
   * reports one cannot hang the turn.
   */
  async runCommand(
    command: string,
    signal: AbortSignal,
    options: RunCommandOptions = {},
  ): Promise<RunCommandResult> {
    const sessionId = this.sessionId;
    let terminalId: string | undefined;
    try {
      const created = await this.client.request(
        acp.methods.client.terminal.create,
        {
          sessionId,
          command,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          outputByteLimit: TERMINAL_OUTPUT_LIMIT,
        },
        { cancellationSignal: signal },
      );
      const id = created.terminalId;
      terminalId = id;
      if (options.toolCallId) {
        void this.client
          .notify("session/update", {
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: options.toolCallId,
              status: "in_progress",
              content: [{ type: "terminal", terminalId: id }],
            },
          })
          .catch(() => {});
      }

      let timedOut = false;
      let killed: Promise<void> | null = null;
      let requestStop!: () => void;
      const stopRequested = new Promise<void>((resolve) => (requestStop = resolve));
      const stop = () => {
        killed ??= this.client
          .request(acp.methods.client.terminal.kill, { sessionId, terminalId: id })
          .then(
            () => {},
            () => {},
          );
        requestStop();
      };
      const onAbort = () => stop();
      if (signal.aborted) stop();
      else signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs ?? this.defaultTimeoutMs);

      let exitCode: number | null = null;
      try {
        const exited = this.client.request(acp.methods.client.terminal.waitForExit, {
          sessionId,
          terminalId: id,
        });
        // After a kill, give the client a grace period to report the exit.
        const gaveUp = stopRequested
          .then(() => killed)
          .then(() => new Promise<null>((resolve) => setTimeout(() => resolve(null), this.killGraceMs)));
        const exit = await Promise.race([exited, gaveUp]);
        exitCode = exit?.exitCode ?? null;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
      signal.throwIfAborted();

      const { output, truncated } = await this.client.request(
        acp.methods.client.terminal.output,
        { sessionId, terminalId: id },
      );
      return { output, truncated, exitCode, timedOut };
    } finally {
      if (terminalId) {
        void this.client
          .request(acp.methods.client.terminal.release, { sessionId, terminalId })
          .catch(() => {});
      }
    }
  }

  async requestUserInput(
    request: UserInputRequest,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<UserInputResponse> {
    const response = await this.client.request(
      acp.methods.client.elicitation.create,
      toElicitationRequest(request, this.sessionId, toolCallId),
      { cancellationSignal: signal },
    );
    return fromElicitationResponse(request, response);
  }
}
