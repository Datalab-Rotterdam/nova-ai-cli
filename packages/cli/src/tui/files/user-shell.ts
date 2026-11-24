import { spawnCommand, terminateProcessTree } from "@datalabrotterdam/nova-ai-agent/core/process-tree.js";

export type UserShellResult = {
  command: string;
  output: string;
  exitCode: number | null;
  /** Stopped by Esc or the timeout. */
  stopped: boolean;
};

const MAX_OUTPUT_CHARS = 64_000;
const TIMEOUT_MS = 120_000;
/** The tail of the output the model gets with the next prompt. */
const CONTEXT_CHARS = 8_000;

/**
 * Runs a `!command` the user typed, in the workspace, without asking: the user
 * is the one running it. Output is stdout+stderr interleaved, tail-capped.
 */
export function runUserShell(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs = TIMEOUT_MS,
): Promise<UserShellResult> {
  const env = { ...process.env };
  delete env.NOVA_API_KEY; // the user's shell doesn't need Nova's credentials
  const child = spawnCommand(command, { cwd, env });
  let output = "";
  let stopped = false;
  const append = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.length > MAX_OUTPUT_CHARS) output = output.slice(-MAX_OUTPUT_CHARS);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const stop = () => {
    stopped = true;
    void terminateProcessTree(child);
  };
  const timer = setTimeout(stop, timeoutMs);
  signal.addEventListener("abort", stop, { once: true });
  return new Promise((resolve) => {
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({ command, output, exitCode, stopped });
    };
    child.once("error", (error) => {
      output += error.message;
      finish(null);
    });
    child.once("close", (code) => finish(code));
  });
}

/** How a run is shown in the transcript (Markdown). */
export function formatShellResult(result: UserShellResult): string {
  const body = result.output.replace(/\s+$/, "") || "(no output)";
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const end = result.stopped
    ? "_Stopped._"
    : result.exitCode === 0
      ? ""
      : `_Exit code ${result.exitCode ?? "unknown"}_`;
  return `${fence}console\n${body}\n${fence}${end ? `\n${end}` : ""}`;
}

/** How a run reaches the model with the next prompt. */
export function shellContext(result: UserShellResult): string {
  const output = result.output.length > CONTEXT_CHARS ? `…${result.output.slice(-CONTEXT_CHARS)}` : result.output;
  const end = result.stopped ? "(stopped)" : `(exit code ${result.exitCode ?? "unknown"})`;
  return `$ ${result.command}\n${output.replace(/\s+$/, "")}\n${end}`;
}
