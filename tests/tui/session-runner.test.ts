import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatMessage } from "@datalabrotterdam/nova-sdk";
import {
  restoreSessionMessages,
  SessionRunner,
} from "../../src/tui/session/session-runner.js";
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
    updateAvailable: null,
  };
}

test("restored sessions rebuild tool exchanges instead of giant user messages", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "Audit the application." },
    {
      role: "assistant",
      content:
        'I will inspect it.\n```tool_call\n{"name":"read_file","args":{"path":"src/index.ts"}}\n```',
    },
    {
      role: "user",
      content: `Tool result: ${"source line\n".repeat(500)}`,
    },
    { role: "assistant", content: "The inspection was interrupted." },
    { role: "user", content: "continue" },
  ];

  const restored = restoreSessionMessages(history);

  assert.deepEqual(
    restored.map((message) => message.role),
    ["user", "assistant", "tool", "assistant", "user"],
  );
  const tool = restored.find((message) => message.role === "tool");
  assert.ok(tool?.role === "tool");
  assert.equal(tool.call.name, "read_file");
  assert.equal(tool.call.status, "completed");
  assert.match(tool.call.output ?? "", /^source line/);
  assert.equal(
    restored.some(
      (message) =>
        message.role === "user" && message.text.startsWith("Tool result:"),
    ),
    false,
  );
});

test("steering enters the active turn at a safe boundary before FIFO follow-ups", async () => {
  const store = createStore(state());
  const runner = new SessionRunner(
    store,
    { apiKey: "test", defaultModel: "test-model" },
    process.cwd(),
  );
  let markFirstStarted!: () => void;
  let releaseTool!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const toolFinished = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  const prompts: string[] = [];
  let cancellations = 0;

  const internals = runner as unknown as {
    ensureSession(): Promise<void>;
    agent: {
      prompt(
        params: {
          prompt: Array<{ type: string; text: string }>;
        },
        context?: unknown,
        runtime?: {
          takeSteeringMessages?(): Promise<
            Array<{ role: string; content: unknown }>
          >;
        },
      ): Promise<{ stopReason: "cancelled" | "end_turn" }>;
      cancel(params: { sessionId: string }): void;
    };
  };
  internals.ensureSession = async () => {};
  internals.agent.prompt = async (params, _context, runtime) => {
    prompts.push(params.prompt[0]?.text ?? "");
    if (prompts.length === 1) {
      markFirstStarted();
      await toolFinished;
      const steered = await runtime?.takeSteeringMessages?.();
      prompts.push(
        ...(steered ?? []).map((message) => String(message.content ?? "")),
      );
    }
    return { stopReason: "end_turn" };
  };
  internals.agent.cancel = () => {
    cancellations++;
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
  assert.deepEqual(
    store
      .getState()
      .messages.flatMap((message) =>
        message.role === "user"
          ? [{ text: message.text, queued: message.queued }]
          : [],
      ),
    [
      { text: "initial request", queued: undefined },
      { text: "urgent steering instruction", queued: "steer" },
      { text: "normal queued follow-up", queued: "followup" },
    ],
  );
  releaseTool();
  await active;

  assert.equal(cancellations, 0);
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

test("queued messages can be edited in place or removed before they run", async () => {
  const store = createStore({ ...state(), busy: true });
  const runner = new SessionRunner(
    store,
    { apiKey: "test", defaultModel: "test-model" },
    process.cwd(),
  );

  await runner.submit("first");
  await runner.submit("second");
  const [first, second] = runner.queuedMessageEntries();
  assert.ok(first);
  assert.ok(second);

  assert.equal(runner.beginQueuedMessageEdit(second.id), true);
  assert.equal(runner.updateQueuedMessage(second.id, "edited second"), true);
  assert.equal(
    runner.finishQueuedMessageEdit(second.id, "edited second"),
    true,
  );
  assert.deepEqual(runner.queuedMessages(), ["first", "edited second"]);

  assert.equal(runner.beginQueuedMessageEdit(first.id), true);
  assert.equal(runner.finishQueuedMessageEdit(first.id, "   "), true);
  assert.deepEqual(runner.queuedMessages(), ["edited second"]);
  assert.equal(store.getState().queuedCount, 1);
  assert.deepEqual(
    store
      .getState()
      .messages.flatMap((message) =>
        message.role === "user" && message.queued
          ? [{ text: message.text, queued: message.queued }]
          : [],
      ),
    [{ text: "edited second", queued: "followup" }],
  );
});

test("live agent output is inserted above visible queued messages", async () => {
  const store = createStore<UIState>({
    ...state(),
    messages: [
      {
        id: "queued-followup",
        role: "user" as const,
        text: "wait until this turn ends",
        queued: "followup" as const,
      },
    ],
  });
  const client = new TuiAcpClient(store, process.cwd());

  await client.sessionUpdate({
    sessionId: "test-session",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Working on the active turn." },
    },
  });
  await client.sessionUpdate({
    sessionId: "test-session",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "active-tool",
      title: "read_file",
      kind: "read",
      status: "pending",
      rawInput: { path: "src/index.ts" },
    },
  });

  assert.deepEqual(
    store
      .getState()
      .messages.map((message) =>
        message.role === "user" && message.queued
          ? `queued:${message.text}`
          : message.role,
      ),
    ["assistant", "tool", "queued:wait until this turn ends"],
  );
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

test("session runner displays a paste marker while sending full clipboard text", async () => {
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
  const marker = "[Pasted from clipboard #1: 12 lines]";
  const pastedText = Array.from(
    { length: 12 },
    (_, index) => `line ${index + 1}`,
  ).join("\n");

  await runner.submit(
    `Review ${marker}`,
    [],
    [
      {
        marker,
        text: pastedText,
        lineCount: 12,
        characterCount: pastedText.length,
      },
    ],
  );

  assert.deepEqual(prompt, [{ type: "text", text: `Review ${pastedText}` }]);
  assert.equal(
    store.getState().messages.find((message) => message.role === "user")?.text,
    `Review ${marker}`,
  );
});

test("queued clipboard text keeps its marker and expands when the prompt runs", async () => {
  const store = createStore(state());
  const runner = new SessionRunner(
    store,
    { apiKey: "test", defaultModel: "test-model" },
    process.cwd(),
  );
  let markStarted!: () => void;
  let releasePrompt!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  const prompts: string[] = [];
  const internals = runner as unknown as {
    ensureSession(): Promise<void>;
    agent: {
      prompt(params: {
        prompt: Array<{ type: string; text: string }>;
      }): Promise<{ stopReason: "end_turn" }>;
    };
  };
  internals.ensureSession = async () => {};
  internals.agent.prompt = async (params) => {
    prompts.push(params.prompt[0]?.text ?? "");
    if (prompts.length === 1) {
      markStarted();
      await released;
    }
    return { stopReason: "end_turn" };
  };
  const marker = "[Pasted from clipboard #1: 1001 characters]";
  const pastedText = "x".repeat(1_001);

  const active = runner.submit("initial request");
  await started;
  await runner.submit(
    `Review ${marker}`,
    [],
    [
      {
        marker,
        text: pastedText,
        lineCount: 1,
        characterCount: pastedText.length,
      },
    ],
  );
  const queuedMessage = store
    .getState()
    .messages.find((message) => message.role === "user" && message.queued);
  assert.ok(queuedMessage?.role === "user");
  assert.equal(queuedMessage.text, `Review ${marker}`);

  releasePrompt();
  await active;

  assert.deepEqual(prompts, ["initial request", `Review ${pastedText}`]);
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
