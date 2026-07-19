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
  assert.equal(parsed.json, true);
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
