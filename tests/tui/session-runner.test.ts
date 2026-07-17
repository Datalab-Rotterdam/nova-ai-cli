import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionRunner } from "../../src/tui/session/session-runner.js";
import { TuiAcpClient } from "../../src/tui/session/tui-acp-client.js";
import { createStore } from "../../src/tui/state/store.js";
import type { UIState } from "../../src/tui/state/types.js";

function state(): UIState {
  return {
    messages: [],
    pendingPermission: null,
    pendingQuestion: null,
    inputHistory: [],
    busy: false,
    mode: "chat",
    permissionMode: "ask",
    interactionMode: "agent",
    sessionId: "test-session",
    cwd: process.cwd(),
    statusLine: null,
    queuedCount: 0,
    contextUsage: null,
  };
}

test("steering cancels the active stream and runs before FIFO queued messages", async () => {
  const store = createStore(state());
  const runner = new SessionRunner(
    store,
    { apiKey: "test", defaultModel: "test-model" },
    process.cwd(),
  );
  let resolveFirst!: (value: { stopReason: "cancelled" }) => void;
  let markFirstStarted!: () => void;
  const firstResponse = new Promise<{ stopReason: "cancelled" }>((resolve) => {
    resolveFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const prompts: string[] = [];
  let cancellations = 0;

  const internals = runner as unknown as {
    ensureSession(): Promise<void>;
    agent: {
      prompt(params: {
        prompt: Array<{ type: string; text: string }>;
      }): Promise<{ stopReason: "cancelled" | "end_turn" }>;
      cancel(params: { sessionId: string }): void;
    };
  };
  internals.ensureSession = async () => {};
  internals.agent.prompt = async (params) => {
    prompts.push(params.prompt[0]?.text ?? "");
    if (prompts.length === 1) {
      markFirstStarted();
      return firstResponse;
    }
    return { stopReason: "end_turn" };
  };
  internals.agent.cancel = () => {
    cancellations++;
    resolveFirst({ stopReason: "cancelled" });
  };

  const active = runner.submit("initial request");
  await firstStarted;
  await runner.submit("normal queued follow-up");
  assert.deepEqual(runner.queuedMessages(), ["normal queued follow-up"]);
  assert.equal(store.getState().queuedCount, 1);

  assert.equal(runner.steer("urgent steering instruction"), true);
  assert.deepEqual(runner.queuedMessages(), [
    "urgent steering instruction",
    "normal queued follow-up",
  ]);
  await active;

  assert.equal(cancellations, 1);
  assert.deepEqual(prompts, [
    "initial request",
    "urgent steering instruction",
    "normal queued follow-up",
  ]);
  assert.deepEqual(runner.queuedMessages(), []);
  assert.equal(store.getState().queuedCount, 0);
  assert.equal(store.getState().busy, false);
  assert.deepEqual(
    store
      .getState()
      .messages.flatMap((message) =>
        message.role === "user" ? [message.text] : [],
      ),
    prompts,
  );
});

test("queued messages can be inspected and cleared", async () => {
  const store = createStore({ ...state(), busy: true });
  const runner = new SessionRunner(
    store,
    { apiKey: "test", defaultModel: "test-model" },
    process.cwd(),
  );

  await runner.submit("one");
  await runner.submit("two");
  assert.deepEqual(runner.queuedMessages(), ["one", "two"]);
  assert.equal(runner.clearQueuedMessages(), 2);
  assert.deepEqual(runner.queuedMessages(), []);
  assert.equal(store.getState().queuedCount, 0);
  assert.match(store.getState().statusLine ?? "", /Cleared 2 queued messages/);
});

test("session runner sends clipboard images as ACP image blocks", async () => {
  const store = createStore(state());
  const runner = new SessionRunner(
    store,
    { apiKey: "test", defaultModel: "test-model" },
    process.cwd(),
  );
  let prompt: Array<Record<string, unknown>> = [];
  const internals = runner as unknown as {
    ensureSession(): Promise<void>;
    agent: {
      prompt(params: {
        prompt: Array<Record<string, unknown>>;
      }): Promise<{ stopReason: "end_turn" }>;
    };
  };
  internals.ensureSession = async () => {};
  internals.agent.prompt = async (params) => {
    prompt = params.prompt;
    return { stopReason: "end_turn" };
  };

  await runner.submit("Inspect [#Image1]", [
    {
      marker: "[#Image1]",
      data: "YWJj",
      mimeType: "image/png",
      byteLength: 3,
    },
  ]);

  assert.deepEqual(prompt, [
    { type: "text", text: "Inspect [#Image1]" },
    { type: "image", data: "YWJj", mimeType: "image/png" },
  ]);
});

test("session runner attaches mentioned file contents to the model prompt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-session-file-"));
  try {
    writeFileSync(join(cwd, "context.md"), "important file context");
    const store = createStore({ ...state(), cwd });
    const runner = new SessionRunner(
      store,
      { apiKey: "test", defaultModel: "test-model" },
      cwd,
    );
    const internals = runner as unknown as {
      injectFileMentions(text: string): Promise<string>;
    };

    const prompt = await internals.injectFileMentions(
      "Please inspect @./context.md.",
    );
    assert.match(prompt, /--- file: context\.md ---/);
    assert.match(prompt, /important file context/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session runner exposes project .mcp.json servers and configuration failures", () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-session-mcp-"));
  try {
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: { command: process.execPath, args: ["server.js"] },
          broken: { type: "http" },
        },
      }),
    );
    const store = createStore({ ...state(), cwd });
    const runner = new SessionRunner(
      store,
      { apiKey: "test", defaultModel: "test-model" },
      cwd,
    );

    assert.deepEqual(
      runner.configuredMcpServers().map((server) => server.name),
      ["local"],
    );
    assert.deepEqual(runner.mcpSessionStatus().configured, [
      { name: "local", transport: "stdio" },
    ]);
    assert.equal(
      runner.mcpSessionStatus().failures[0]?.serverName,
      ".mcp.json:broken",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("terminal output updates its pending tool call while the command runs", async () => {
  const store = createStore(state());
  const client = new TuiAcpClient(store, process.cwd());
  await client.sessionUpdate({
    sessionId: "test-session",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "shell-call",
      title: "run_command",
      kind: "execute",
      status: "pending",
      rawInput: { command: process.execPath },
    },
  });

  const terminal = await client.createTerminal({
    sessionId: "test-session",
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write('first\\n'); setTimeout(() => process.stdout.write('second\\n'), 250)",
    ],
  });

  await waitFor(() => pendingToolOutput(store.getState()).includes("first"));
  assert.equal(pendingToolOutput(store.getState()).includes("second"), false);
  await client.waitForTerminalExit({
    sessionId: "test-session",
    terminalId: terminal.terminalId,
  });
  assert.match(pendingToolOutput(store.getState()), /first[\s\S]*second/);
  await client.releaseTerminal({
    sessionId: "test-session",
    terminalId: terminal.terminalId,
  });
});

test("pending tools are failed with context when a request ends unexpectedly", async () => {
  const store = createStore(state());
  const client = new TuiAcpClient(store, process.cwd());
  await client.sessionUpdate({
    sessionId: "test-session",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "stuck-call",
      title: "run_command",
      kind: "execute",
      status: "pending",
      rawInput: { command: "long-running-command" },
    },
  });
  await client.sessionUpdate({
    sessionId: "test-session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "stuck-call",
      status: "pending",
      content: [
        { type: "content", content: { type: "text", text: "partial output" } },
      ],
    },
  });

  assert.equal(
    client.failPendingTools("Request failed: transport disconnected."),
    1,
  );
  const message = store
    .getState()
    .messages.find(
      (item) => item.role === "tool" && item.call.toolCallId === "stuck-call",
    );
  assert.equal(message?.role, "tool");
  if (message?.role !== "tool") throw new Error("Expected a tool message.");
  assert.equal(message.call.status, "failed");
  assert.match(
    message.call.output ?? "",
    /partial output[\s\S]*transport disconnected/,
  );
  assert.equal(client.failPendingTools("duplicate"), 0);
});

test("automatic context compaction feedback appears in the transcript", async () => {
  const store = createStore(state());
  const client = new TuiAcpClient(store, process.cwd());
  await client.sessionUpdate({
    sessionId: "test-session",
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: {
        type: "text",
        text: "Context compacted automatically: summarized 20 older messages.",
      },
    },
  });

  const message = store.getState().messages.at(-1);
  assert.equal(message?.role, "assistant");
  if (message?.role !== "assistant")
    throw new Error("Expected compaction feedback.");
  assert.equal(message.streaming, false);
  assert.match(message.text, /Context compacted automatically/);
});

function pendingToolOutput(current: UIState): string {
  const message = current.messages.find(
    (item) => item.role === "tool" && item.call.toolCallId === "shell-call",
  );
  return message?.role === "tool" ? (message.call.output ?? "") : "";
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for terminal preview.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
