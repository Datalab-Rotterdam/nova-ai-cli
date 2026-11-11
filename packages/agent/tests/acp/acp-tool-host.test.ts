import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpToolHost } from "../../src/acp/acp-tool-host.js";

type Call = { method: string; params: Record<string, unknown> };

/** A scripted client terminal: `exitAfterKill` decides whether a kill ends the command. */
function fakeTerminalClient(options: { exitCode?: number | null; runsUntilKilled?: boolean; exitAfterKill?: boolean } = {}) {
  const calls: Call[] = [];
  let exit!: (value: { exitCode: number | null }) => void;
  const exited = new Promise<{ exitCode: number | null }>((resolve) => (exit = resolve));
  if (!options.runsUntilKilled) exit({ exitCode: options.exitCode ?? 0 });
  const client = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      switch (method) {
        case "terminal/create":
          return { terminalId: "t1" };
        case "terminal/wait_for_exit":
          return exited;
        case "terminal/kill":
          if (options.exitAfterKill !== false) exit({ exitCode: null });
          return {};
        case "terminal/output":
          return { output: "out", truncated: false };
        default:
          return {};
      }
    },
    notify: async (method: string, params: Record<string, unknown>) => void calls.push({ method, params }),
  } as unknown as acp.AgentContext;
  return { client, calls };
}

const names = (calls: Call[]) => calls.map((call) => call.method);

describe("AcpToolHost.runCommand", () => {
  it("runs in the workspace with an output limit and attaches the terminal to the tool call", async () => {
    const { client, calls } = fakeTerminalClient({ exitCode: 3 });
    const host = new AcpToolHost(client, "s1");
    const result = await host.runCommand("npm test", new AbortController().signal, { cwd: "/repo", toolCallId: "call-1" });
    assert.deepEqual(result, { output: "out", truncated: false, exitCode: 3, timedOut: false });
    assert.deepEqual(calls[0], {
      method: "terminal/create",
      params: { sessionId: "s1", command: "npm test", cwd: "/repo", outputByteLimit: 100_000 },
    });
    const update = calls.find((call) => call.method === "session/update")!;
    assert.deepEqual((update.params.update as Record<string, unknown>).content, [{ type: "terminal", terminalId: "t1" }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(names(calls).includes("terminal/release"));
  });

  it("kills a command that outlives its timeout", async () => {
    const { client, calls } = fakeTerminalClient({ runsUntilKilled: true });
    const host = new AcpToolHost(client, "s1");
    const result = await host.runCommand("sleep 100", new AbortController().signal, { timeoutMs: 20 });
    assert.equal(result.timedOut, true);
    assert.ok(names(calls).includes("terminal/kill"));
  });

  it("uses the session's default time limit when the command sets none", async () => {
    const { client, calls } = fakeTerminalClient({ runsUntilKilled: true });
    const host = new AcpToolHost(client, "s1", { defaultTimeoutMs: 20 });
    const result = await host.runCommand("sleep 100", new AbortController().signal);
    assert.equal(result.timedOut, true);
    assert.ok(names(calls).includes("terminal/kill"));
  });

  it("does not hang when the client never reports an exit after a kill", async () => {
    const { client } = fakeTerminalClient({ runsUntilKilled: true, exitAfterKill: false });
    const host = new AcpToolHost(client, "s1", { killGraceMs: 30 });
    const started = Date.now();
    const result = await host.runCommand("hang", new AbortController().signal, { timeoutMs: 20 });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.ok(Date.now() - started < 2_000);
  });

  it("kills the command when the turn is cancelled", async () => {
    const { client, calls } = fakeTerminalClient({ runsUntilKilled: true });
    const host = new AcpToolHost(client, "s1");
    const controller = new AbortController();
    const running = host.runCommand("sleep 100", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assert.rejects(running);
    assert.ok(names(calls).includes("terminal/kill"));
  });
});
