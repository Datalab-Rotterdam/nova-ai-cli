import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, NovaAI } from "@datalabrotterdam/nova-sdk";
import type { ToolEnvironment } from "../../src/acp/tools/environment.js";
import type { ToolDefinition } from "../../src/acp/tools/types.js";
import type { AgentEvent } from "../../src/core/agent-events.js";
import type { ToolHost } from "../../src/core/tool-host.js";
import { runTurn } from "../../src/core/run-turn.js";

test("sentinel tool calls execute without leaking their marker into streamed text", async () => {
  const rounds = [
    [
      "I will inspect. <|tool_",
      'call>call:list_directory: {path: "."}',
      "<tool_call|>ignored trailing text",
    ],
    ["Inspection complete."],
  ];
  const novaClient = {
    chat: {
      completions: {
        stream: () => {
          const chunks = rounds.shift() ?? [];
          return (async function* () {
            for (const content of chunks) {
              yield {
                type: "chunk",
                data: { choices: [{ delta: { content } }] },
              };
            }
          })();
        },
      },
    },
  } as unknown as NovaAI;

  const events: AgentEvent[] = [];
  let executedArgs: Record<string, unknown> | null = null;
  const tool: ToolDefinition = {
    name: "list_directory",
    description: "test directory listing",
    mutating: false,
    kind: "search",
    execute: async (_context, args) => {
      executedArgs = args;
      return { output: "a.ts\nb.ts" };
    },
  };
  const messages: ChatMessage[] = [
    { role: "user", content: "Inspect the repository." },
  ];

  const result = await runTurn(messages, new AbortController().signal, {
    host: {} as ToolHost,
    sessionId: "test-session",
    cwd: ".",
    environment: {} as ToolEnvironment,
    tools: [tool],
    requestPermission: async () => true,
    emit: (event) => {
      events.push(event);
    },
    novaClient,
    model: "test-model",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(executedArgs, { path: "." });
  assert.deepEqual(
    events.filter((event) => event.type === "text").map((event) => event.text),
    ["I will inspect. ", "Inspection complete."],
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "tool_pending" && event.name === "list_directory",
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === "tool_update" && event.status === "completed",
    ),
  );
  assert.equal(
    events.some(
      (event) => event.type === "text" && event.text.includes("tool_call"),
    ),
    false,
  );
});

test("unexpected permission failures settle the pending tool and let the model recover", async () => {
  const rounds = [
    [
      '<|tool_call>call:write_file: {path: "note.txt", content: "hello"}<tool_call|>',
    ],
    ["I could not update the file."],
  ];
  const novaClient = {
    chat: {
      completions: {
        stream: () => {
          const chunks = rounds.shift() ?? [];
          return (async function* () {
            for (const content of chunks) {
              yield {
                type: "chunk",
                data: { choices: [{ delta: { content } }] },
              };
            }
          })();
        },
      },
    },
  } as unknown as NovaAI;
  const tool: ToolDefinition = {
    name: "write_file",
    description: "test write",
    mutating: true,
    kind: "edit",
    execute: async () => ({ output: "should not execute" }),
  };
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [
    { role: "user", content: "Write the file." },
  ];

  const result = await runTurn(messages, new AbortController().signal, {
    host: {} as ToolHost,
    sessionId: "test-session",
    cwd: ".",
    environment: {} as ToolEnvironment,
    tools: [tool],
    requestPermission: async () => {
      throw new Error("permission channel closed");
    },
    emit: (event) => {
      events.push(event);
    },
    novaClient,
    model: "test-model",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.ok(events.some((event) => event.type === "tool_pending"));
  assert.ok(
    events.some(
      (event) =>
        event.type === "tool_update" &&
        event.status === "failed" &&
        event.output === "permission channel closed",
    ),
  );
  assert.ok(
    messages.some(
      (message) =>
        message.role === "user" &&
        message.content === "Tool error: permission channel closed",
    ),
  );
});

test("a maximum-context error compacts history and retries the interrupted round once", async () => {
  const overflow = Object.assign(
    new Error(
      "This model's maximum context length is 262144 tokens. However, your prompt contains at least 262145 input tokens. Please reduce the length of the input prompt. (parameter=input_tokens, value=262145)",
    ),
    { status: 400 },
  );
  let attempts = 0;
  const requestSnapshots: ChatMessage[][] = [];
  const novaClient = {
    chat: {
      completions: {
        stream: (request: { messages: ChatMessage[] }) => {
          requestSnapshots.push([...request.messages]);
          return (async function* () {
            attempts++;
            if (attempts === 1) throw overflow;
            yield {
              type: "chunk",
              data: {
                choices: [
                  { delta: { content: "Recovered after compaction." } },
                ],
              },
            };
          })();
        },
      },
    },
  } as unknown as NovaAI;
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [
    { role: "user", content: "old context" },
    { role: "assistant", content: "old response" },
    { role: "user", content: "current request" },
  ];
  let compactions = 0;

  const result = await runTurn(messages, new AbortController().signal, {
    host: {} as ToolHost,
    sessionId: "test-session",
    cwd: ".",
    environment: {} as ToolEnvironment,
    tools: [],
    requestPermission: async () => true,
    compactContext: async (currentMessages) => {
      compactions++;
      const history = [
        { role: "system" as const, content: "compacted summary" },
        currentMessages.at(-1)!,
      ];
      currentMessages.splice(0, currentMessages.length, ...history);
      return { compacted: true, history, removedMessages: 2, keptMessages: 1 };
    },
    emit: (event) => {
      events.push(event);
    },
    novaClient,
    model: "test-model",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(attempts, 2);
  assert.equal(compactions, 1);
  assert.equal(requestSnapshots[1]?.[0]?.content, "compacted summary");
  assert.deepEqual(
    events.map((event) => event.type),
    ["context_compacted", "text"],
  );
  assert.equal(
    events[0]?.type === "context_compacted" ? events[0].removedMessages : null,
    2,
  );
});

test("a least-privilege mode switch blocks every later tool in the same turn", async () => {
  const rounds = [
    ["<|tool_call>call:enter_plan_mode: {}<tool_call|>"],
    ["<|tool_call>call:run_command: {command: \"npm publish\"}<tool_call|>"],
    ["Here is the implementation plan."],
  ];
  const novaClient = {
    chat: {
      completions: {
        stream: () => {
          const chunks = rounds.shift() ?? [];
          return (async function* () {
            for (const content of chunks) {
              yield {
                type: "chunk",
                data: { choices: [{ delta: { content } }] },
              };
            }
          })();
        },
      },
    },
  } as unknown as NovaAI;
  let commandCalls = 0;
  const tools: ToolDefinition[] = [
    {
      name: "enter_plan_mode",
      description: "enter plan mode",
      mutating: false,
      kind: "switch_mode",
      execute: async () => ({
        output: "Switched to plan mode.",
        disableFurtherTools: true,
      }),
    },
    {
      name: "run_command",
      description: "run a command",
      mutating: true,
      kind: "execute",
      execute: async () => {
        commandCalls++;
        return { output: "unexpected" };
      },
    },
  ];
  const messages: ChatMessage[] = [
    { role: "user", content: "Inspect, then plan." },
  ];
  let completionNotificationFailed = false;

  const result = await runTurn(messages, new AbortController().signal, {
    host: {} as ToolHost,
    sessionId: "test-session",
    cwd: ".",
    environment: {} as ToolEnvironment,
    tools,
    requestPermission: async () => true,
    emit: (event) => {
      if (
        !completionNotificationFailed &&
        event.type === "tool_update" &&
        event.status === "completed"
      ) {
        completionNotificationFailed = true;
        throw new Error("client disconnected while rendering mode change");
      }
    },
    novaClient,
    model: "test-model",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(completionNotificationFailed, true);
  assert.equal(commandCalls, 0);
  assert.ok(
    messages.some(
      (message) =>
        message.role === "user" &&
        message.content === 'Tool "run_command" is not available.',
    ),
  );
});
