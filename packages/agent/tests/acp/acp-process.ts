import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";

// Compiled to dist-test/packages/agent/tests/acp; the agent command is
// dist-test/packages/agent/src/bin.js.
const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "bin.js");

export type AcpProcess = {
  connection: acp.ClientSideConnection;
  child: ChildProcess;
  updates: acp.SessionNotification[];
  stdoutLines: string[];
  home: string;
  close(): Promise<number | null>;
};

/** Starts `nova-ai --acp` as a real child process, as an editor would. */
export function startAcpProcess(
  client: Partial<acp.Client> = {},
  env: Record<string, string> = {},
): AcpProcess {
  const home = mkdtempSync(join(tmpdir(), "nova-acp-proc-"));
  const child = spawn(process.execPath, [ENTRY, "--acp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NOVA_AI_HOME: home, NOVA_AI_CLI_SESSIONS_DIR: join(home, "sessions"), ...env },
  });
  const stdoutLines: string[] = [];
  let buffered = "";
  // Tee stdout: the connection reads it, and the test checks every line is JSON-RPC.
  const tee = new Readable({ read() {} });
  child.stdout!.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    stdoutLines.push(...lines.filter(Boolean));
    tee.push(chunk);
  });
  child.stdout!.on("end", () => tee.push(null));
  const updates: acp.SessionNotification[] = [];
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(tee) as ReadableStream<Uint8Array>,
  );
  const connection = new acp.ClientSideConnection(
    () => ({
      sessionUpdate: async (params) => void updates.push(params),
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      ...client,
    }) as acp.Client,
    stream,
  );
  return {
    connection,
    child,
    updates,
    stdoutLines,
    home,
    close: () =>
      new Promise((resolveExit) => {
        child.once("exit", (code) => {
          rmSync(home, { recursive: true, force: true });
          resolveExit(code);
        });
        child.stdin!.end();
      }),
  };
}
