import assert from "node:assert/strict";
import test from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import {
  parseHeadlessArgs,
  runHeadless,
  type HeadlessDependencies,
} from "../../src/headless/index.js";
import type { HeadlessEvent } from "../../src/headless/client.js";

test("headless arguments support positional prompts and explicit automation controls", () => {
  const parsed = parseHeadlessArgs(
    [
      "--json",
      "--no-mcp",
      "--cwd",
      ".",
      "--model=nova-test",
      "--permission-mode",
      "accept-edits",
      "inspect",
      "this",
    ],
    process.cwd(),
  );

  assert.equal(parsed.prompt, "inspect this");
  assert.equal(parsed.outputFormat, "stream-json");
  assert.equal(parsed.mcp, false);
  assert.equal(parsed.model, "nova-test");
  assert.equal(parsed.permissionMode, "accept-edits");
  assert.throws(
    () => parseHeadlessArgs(["--permission-mode=ask"], process.cwd()),
    /Unknown permission mode/,
  );
});

test("headless JSON mode emits ordered JSON Lines and a deterministic result", async () => {
  const stdout = capture();
  const stderr = capture();
  const fake = fakeRuntime("end_turn");

  const exitCode = await runHeadless(["--json", "--no-mcp", "hello"], {
    agent: fake.agent,
    clientFactory: fake.clientFactory,
    stdout,
    stderr,
    registerSignals: false,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value, "");
  const records = stdout.value
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    records.map((record) => record.type),
    ["session.started", "message", "message.delta", "result"],
  );
  assert.equal(records[2]?.text, "finished");
  assert.equal(records[3]?.exitCode, 0);
  assert.equal(fake.closed, true);
});

test("plain headless mode prints only assistant text and maps the safety limit", async () => {
  const stdout = capture();
  const stderr = capture();
  const fake = fakeRuntime("max_turn_requests");

  const exitCode = await runHeadless(["--no-mcp", "hello"], {
    agent: fake.agent,
    clientFactory: fake.clientFactory,
    stdout,
    stderr,
    registerSignals: false,
  });

  assert.equal(exitCode, 3);
  assert.equal(stdout.value, "finished\n");
  assert.equal(stderr.value, "");
});

test("headless mode reads a prompt from piped stdin", async () => {
  const stdout = capture();
  const fake = fakeRuntime("end_turn");

  const exitCode = await runHeadless(["--json", "--no-mcp"], {
    agent: fake.agent,
    clientFactory: fake.clientFactory,
    stdout,
    stderr: capture(),
    readStdin: async () => "from stdin\n",
    registerSignals: false,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.value, /"text":"from stdin"/);
});

function fakeRuntime(stopReason: "end_turn" | "max_turn_requests"): {
  agent: NonNullable<HeadlessDependencies["agent"]>;
  clientFactory: NonNullable<HeadlessDependencies["clientFactory"]>;
  closed: boolean;
} {
  const runtime = {
    closed: false,
    context: null as acp.AgentContext | null,
  };
  const agent = {
    initialize: () => ({}),
    newSession: async () => ({ sessionId: "headless-test" }),
    resumeSession: async () => ({}),
    prompt: async (_params: acp.PromptRequest, context: acp.AgentContext) => {
      await context.notify("session/update", {
        sessionId: "headless-test",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "finished" },
        },
      });
      return { stopReason };
    },
    cancel: () => {},
    closeSession: async () => ({}),
    setSessionConfigOption: async () => ({ configOptions: [] }),
  } as unknown as NonNullable<HeadlessDependencies["agent"]>;
  const clientFactory = (
    _cwd: string,
    _permissionMode: string,
    emit: (event: HeadlessEvent) => void | Promise<void>,
  ) => ({
    capabilities: {},
    context: () =>
      ({
        request: async () => ({}),
        notify: async (method: string, params: unknown) => {
          await emit({ type: "notification", method, params });
        },
      }) as unknown as acp.AgentContext,
    close: async () => {
      runtime.closed = true;
    },
  });
  return {
    agent,
    clientFactory: clientFactory as NonNullable<
      HeadlessDependencies["clientFactory"]
    >,
    get closed() {
      return runtime.closed;
    },
  };
}

function capture(): { value: string; write(chunk: string): void } {
  return {
    value: "",
    write(chunk: string) {
      this.value += chunk;
    },
  };
}

test("headless runs the real agent over ACP end to end", async () => {
  const { withFakeNova, sse, text } = await import("../acp/fake-nova.js");
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  await withFakeNova(
    () => sse([text("Done headless.")]),
    async (requests, home) => {
      const cwd = join(home, "repo");
      mkdirSync(cwd, { recursive: true });
      const out: string[] = [];
      const err: string[] = [];
      const code = await runHeadless(["--json", "--cwd", cwd, "-p", "say done"], {
        stdout: { write: (chunk: string) => out.push(chunk) },
        stderr: { write: (chunk: string) => err.push(chunk) },
        registerSignals: false,
      });
      assert.equal(code, 0, err.join(""));
      const events = out.join("").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(events.at(-1).type, "result");
      assert.equal(events.at(-1).stopReason, "end_turn");
      assert.match(JSON.stringify(events), /Done headless\./);
      assert.equal(requests.length, 1);
    },
  );
});

test("--output-format json writes one object with the answer and tools", async () => {
  const { withFakeNova, sse, text } = await import("../acp/fake-nova.js");
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  await withFakeNova(
    () => sse([text("All good.")]),
    async (_requests, home) => {
      const cwd = join(home, "repo");
      mkdirSync(cwd, { recursive: true });
      const out: string[] = [];
      const code = await runHeadless(["-p", "check", "--output-format", "json", "--cwd", cwd], {
        stdout: { write: (chunk: string) => out.push(chunk) },
        stderr: { write: () => {} },
        registerSignals: false,
      });
      assert.equal(code, 0);
      const lines = out.join("").trim().split("\n");
      assert.equal(lines.length, 1, "exactly one JSON object");
      const result = JSON.parse(lines[0]!);
      assert.equal(result.type, "result");
      assert.equal(result.text, "All good.");
      assert.equal(result.stopReason, "end_turn");
      assert.deepEqual(result.tools, []);
    },
  );
});

test("--continue resumes the newest session of the workspace", async () => {
  const { withFakeNova, sse, text } = await import("../acp/fake-nova.js");
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { appendSessionTurn } = await import("../../src/core/sessions.js");
  await withFakeNova(
    () => sse([text("Continued.")]),
    async (requests, home) => {
      const cwd = join(home, "repo");
      mkdirSync(cwd, { recursive: true });
      const out: string[] = [];
      const err: string[] = [];
      const none = await runHeadless(["-p", "x", "-c", "--cwd", cwd], {
        stdout: { write: (c: string) => out.push(c) },
        stderr: { write: (c: string) => err.push(c) },
        registerSignals: false,
      });
      assert.equal(none, 1);
      assert.match(err.join(""), /No earlier session/);

      const sessionId = crypto.randomUUID();
      appendSessionTurn(sessionId, { cwd, title: "earlier" }, [
        { role: "user", content: "remember 42" },
        { role: "assistant", content: "ok" },
      ]);
      const code = await runHeadless(["-p", "what number?", "-c", "--cwd", cwd, "--json"], {
        stdout: { write: (c: string) => out.push(c) },
        stderr: { write: () => {} },
        registerSignals: false,
      });
      assert.equal(code, 0);
      const sent = requests.at(-1)!.body.messages as Array<{ role: string; content: unknown }>;
      assert.ok(JSON.stringify(sent).includes("remember 42"), "earlier history was sent");
    },
  );
});
