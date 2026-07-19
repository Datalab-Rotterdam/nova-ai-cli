import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunCommandResult, ToolHost } from "./tool-host.js";

const OUTPUT_CAP = 100_000;

export class LocalToolHost implements ToolHost {
  constructor(private readonly cwd: string) {}

  async readTextFile(path: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    return readFile(path, "utf8");
  }

  async writeTextFile(path: string, content: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  runCommand(command: string, signal: AbortSignal): Promise<RunCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, { cwd: this.cwd, shell: true });

      let output = "";
      let truncated = false;
      const append = (chunk: Buffer) => {
        if (truncated) return;
        output += chunk.toString("utf8");
        if (output.length > OUTPUT_CAP) {
          output = output.slice(0, OUTPUT_CAP);
          truncated = true;
        }
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);

      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (exitCode) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ output, truncated, exitCode });
      });
    });
  }
}
