import type { UserInputRequest, UserInputResponse } from "./user-questions.js";

export type RunCommandResult = {
  output: string;
  truncated: boolean;
  exitCode: number | null;
  /** The command ran longer than its timeout and was stopped. */
  timedOut?: boolean;
};

export type RunCommandOptions = {
  /** Working directory; the session's workspace. */
  cwd?: string;
  /** Lets the host attach the live terminal to this tool call. */
  toolCallId?: string;
  timeoutMs?: number;
};

/** Default and maximum time a command may run before it is stopped. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_TIMEOUT_MS = 600_000;

export type ToolHost = {
  readTextFile(path: string, signal: AbortSignal): Promise<string>;
  writeTextFile(
    path: string,
    content: string,
    signal: AbortSignal,
  ): Promise<void>;
  runCommand(
    command: string,
    signal: AbortSignal,
    options?: RunCommandOptions,
  ): Promise<RunCommandResult>;
  requestUserInput?(
    request: UserInputRequest,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<UserInputResponse>;
};
