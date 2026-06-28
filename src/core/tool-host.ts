export type RunCommandResult = {
  output: string;
  truncated: boolean;
  exitCode: number | null;
};

export type ToolHost = {
  readTextFile(path: string, signal: AbortSignal): Promise<string>;
  writeTextFile(path: string, content: string, signal: AbortSignal): Promise<void>;
  runCommand(command: string, signal: AbortSignal): Promise<RunCommandResult>;
};
