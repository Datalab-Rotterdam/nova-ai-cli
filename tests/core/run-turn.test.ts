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

test("steering messages join an active turn after a tool completes", async () => {
  const rounds = [
    ['```tool_call\n{"name":"read_file","args":{"path":"large.ts"}}\n```'],
    ["I stopped after the requested file."],
  ];
  const requests: ChatMessage[][] = [];
  const novaClient = {
    chat: {
      completions: {
        stream: (request: { messages: ChatMessage[] }) => {
          requests.push([...request.messages]);
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
  let toolCompleted = false;
  let steeringReads = 0;
  const tool: ToolDefinition = {
    name: "read_file",
    description: "test read",
    mutating: false,
    kind: "read",
    execute: async () => {
      toolCompleted = true;
      return { output: "file contents" };
    },
  };
  const messages: ChatMessage[] = [
    { role: "user", content: "Inspect every file." },
  ];

  const result = await runTurn(messages, new AbortController().signal, {
    host: {} as ToolHost,
    sessionId: "test-session",
    cwd: ".",
    environment: {} as ToolEnvironment,
    tools: [tool],
    requestPermission: async () => true,
    takeSteeringMessages: () => {
      steeringReads++;
      assert.equal(toolCompleted, true);
      return [{ role: "user", content: "Only inspect large.ts, then stop." }];
    },
    emit: () => {},
    novaClient,
    model: "test-model",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(steeringReads, 1);
  assert.deepEqual(requests[1]?.slice(-2), [
    { role: "user", content: "Tool result: file contents" },
    { role: "user", content: "Only inspect large.ts, then stop." },
  ]);
  assert.ok(
    result.turnMessages.some(
      (message) =>
        message.role === "user" &&
        message.content === "Only inspect large.ts, then stop.",
    ),
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
    ['<|tool_call>call:run_command: {command: "npm publish"}<tool_call|>'],
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

test("long tasks continue beyond the former ten-tool ceiling", async () => {
  let requests = 0;
  let toolCalls = 0;
  const novaClient = {
    chat: {
      completions: {
        stream: () => {
          requests++;
          const content =
            requests <= 11
              ? '```tool_call\n{"name":"read_file","args":{"path":"file-' +
                requests +
                '.ts"}}\n```'
              : "Audit complete after all required inspections.";
          return (async function* () {
            yield {
              type: "chunk",
              data: { choices: [{ delta: { content } }] },
            };
          })();
        },
      },
    },
  } as unknown as NovaAI;
  const tool: ToolDefinition = {
    name: "read_file",
    description: "test read",
    mutating: false,
    kind: "read",
    execute: async () => {
      toolCalls++;
      return { output: "contents" };
    },
  };
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [{ role: "user", content: "Audit it." }];

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
  assert.equal(toolCalls, 11);
  assert.equal(requests, 12);
  assert.equal(
    events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join(""),
    "Audit complete after all required inspections.",
  );
});

test("an empty completion after a tool result is retried instead of ending the turn", async () => {
  const rounds = [
    ['```tool_call\n{"name":"read_file","args":{"path":"a.ts"}}\n```'],
    [],
    ["The inspected file is safe."],
  ];
  const requestMessages: ChatMessage[][] = [];
  const novaClient = {
    chat: {
      completions: {
        stream: (request: { messages: ChatMessage[] }) => {
          requestMessages.push(request.messages);
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
    name: "read_file",
    description: "test read",
    mutating: false,
    kind: "read",
    execute: async () => ({ output: "contents" }),
  };
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [{ role: "user", content: "Inspect a.ts" }];

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
  assert.equal(requestMessages.length, 3);
  assert.match(
    String(requestMessages[2]?.at(-1)?.content),
    /previous completion contained no visible assistant response/i,
  );
  assert.equal(
    messages.some(
      (message) =>
        message.role === "assistant" &&
        typeof message.content === "string" &&
        !message.content.trim(),
    ),
    false,
  );
  assert.equal(
    events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join(""),
    "The inspected file is safe.",
  );
});

test("think blocks and stray think tags never reach streamed or stored assistant text", async () => {
  const novaClient = {
    chat: {
      completions: {
        stream: () =>
          (async function* () {
            for (const content of [
              "Visible before. <thi",
              "nk>private reasoning",
              "</think> Visible after. </thi",
              "nk><think/>",
            ]) {
              yield {
                type: "chunk",
                data: { choices: [{ delta: { content } }] },
              };
            }
          })(),
      },
    },
  } as unknown as NovaAI;
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [{ role: "user", content: "Answer." }];

  const result = await runTurn(messages, new AbortController().signal, {
    host: {} as ToolHost,
    sessionId: "test-session",
    cwd: ".",
    environment: {} as ToolEnvironment,
    tools: [],
    requestPermission: async () => true,
    emit: (event) => {
      events.push(event);
    },
    novaClient,
    model: "test-model",
  });

  const streamed = events
    .filter((event) => event.type === "text")
    .map((event) => event.text)
    .join("");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(streamed, "Visible before.  Visible after. ");
  assert.doesNotMatch(streamed, /think|private reasoning/i);
  assert.equal(messages.at(-1)?.content, "Visible before.  Visible after. ");
});

test("the tool safety ceiling forces a final response instead of ending after a tool result", async () => {
  let requests = 0;
  let toolCalls = 0;
  const novaClient = {
    chat: {
      completions: {
        stream: (request: { messages: ChatMessage[] }) => {
          requests++;
          const content =
            requests <= 2
              ? '```tool_call\n{"name":"read_file","args":{"path":"a.ts"}}\n```'
              : "Best available final assessment.";
          if (requests === 3) {
            assert.match(
              String(request.messages.at(-1)?.content),
              /tool-use safety limit has been reached/i,
            );
          }
          return (async function* () {
            yield {
              type: "chunk",
              data: { choices: [{ delta: { content } }] },
            };
          })();
        },
      },
    },
  } as unknown as NovaAI;
  const tool: ToolDefinition = {
    name: "read_file",
    description: "test read",
    mutating: false,
    kind: "read",
    execute: async () => {
      toolCalls++;
      return { output: "contents" };
    },
  };
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [{ role: "user", content: "Audit it." }];

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
    maxToolRounds: 2,
  });

  assert.equal(result.stopReason, "max_turn_requests");
  assert.equal(toolCalls, 2);
  assert.equal(requests, 3);
  assert.equal(
    events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join(""),
    "Best available final assessment.",
  );
});

test("a length-limited response continues in the same assistant message", async () => {
  const rounds = [
    { content: "Here are the security", finishReason: "length" },
    { content: " findings from the audit.", finishReason: "stop" },
  ];
  const requests: ChatMessage[][] = [];
  const novaClient = {
    chat: {
      completions: {
        stream: (request: { messages: ChatMessage[] }) => {
          requests.push(request.messages);
          const round = rounds.shift()!;
          return (async function* () {
            yield {
              type: "chunk",
              data: {
                choices: [
                  {
                    delta: { content: round.content },
                    finish_reason: round.finishReason,
                  },
                ],
              },
            };
            yield { type: "done" };
          })();
        },
      },
    },
  } as unknown as NovaAI;
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [{ role: "user", content: "Audit it." }];

  const result = await runTurn(messages, new AbortController().signal, {
    host: {} as ToolHost,
    sessionId: "test-session",
    cwd: ".",
    environment: {} as ToolEnvironment,
    tools: [],
    requestPermission: async () => true,
    emit: (event) => {
      events.push(event);
    },
    novaClient,
    model: "test-model",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.at(-2)?.content, "Here are the security");
  assert.match(
    String(requests[1]?.at(-1)?.content),
    /previous response was cut off/i,
  );
  assert.equal(
    events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join(""),
    "Here are the security findings from the audit.",
  );
  assert.equal(
    messages.at(-1)?.content,
    "Here are the security findings from the audit.",
  );
  assert.equal(
    messages.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("previous response was cut off"),
    ),
    false,
  );
});

test("the reported incomplete completion preamble is continued even with a stop reason", async () => {
  const rounds = [
    { content: "Excellent. I've completed", finishReason: "stop" },
    {
      content: " the audit. The concrete findings follow.",
      finishReason: "stop",
    },
  ];
  const novaClient = {
    chat: {
      completions: {
        stream: () => {
          const round = rounds.shift()!;
          return (async function* () {
            yield {
              type: "chunk",
              data: {
                choices: [
                  {
                    delta: { content: round.content },
                    finish_reason: round.finishReason,
                  },
                ],
              },
            };
          })();
        },
      },
    },
  } as unknown as NovaAI;
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [{ role: "user", content: "Audit it." }];

  const result = await runTurn(messages, new AbortController().signal, {
    host: {} as ToolHost,
    sessionId: "test-session",
    cwd: ".",
    environment: {} as ToolEnvironment,
    tools: [],
    requestPermission: async () => true,
    emit: (event) => {
      events.push(event);
    },
    novaClient,
    model: "test-model",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(
    events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join(""),
    "Excellent. I've completed the audit. The concrete findings follow.",
  );
  assert.equal(
    messages.at(-1)?.content,
    "Excellent. I've completed the audit. The concrete findings follow.",
  );
});

test("an interrupted tool fence is re-emitted and never streamed as assistant text", async () => {
  const rounds = [
    [
      "I will write the plan.\n",
      '```tool_call\n{"name":"write_file","args":{"path":"plan.md","content":"unfinished',
    ],
    [
      '```tool_call\n{"name":"write_file","args":{"path":"plan.md","content":"complete plan"}}\n```',
    ],
    ["The remediation plan was written."],
  ];
  const requests: ChatMessage[][] = [];
  const novaClient = {
    chat: {
      completions: {
        stream: (request: { messages: ChatMessage[] }) => {
          requests.push(request.messages);
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
  let writtenContent = "";
  const tool: ToolDefinition = {
    name: "write_file",
    description: "test write",
    mutating: false,
    kind: "edit",
    execute: async (_context, args) => {
      writtenContent = String(args.content);
      return { output: "Wrote plan.md" };
    },
  };
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [{ role: "user", content: "Write a plan." }];

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

  const streamed = events
    .filter((event) => event.type === "text")
    .map((event) => event.text)
    .join("");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(requests.length, 3);
  assert.match(
    String(requests[1]?.at(-2)?.content),
    /```tool_call[\s\S]*unfinished/,
  );
  assert.match(
    String(requests[1]?.at(-1)?.content),
    /Re-emit the entire tool call/,
  );
  assert.equal(writtenContent, "complete plan");
  assert.equal(
    streamed,
    "I will write the plan.\nThe remediation plan was written.",
  );
  assert.doesNotMatch(streamed, /tool_call|unfinished|write_file/);
});

test("invalid tool args get a correction round and never reach the tool", async () => {
  const rounds = [
    ['```tool_call\n{"name":"read_file","args":{}}\n```'],
    ['```tool_call\n{"name":"read_file","args":{"path":"src/a.ts"}}\n```'],
    ["Done reading."],
  ];
  const requests: ChatMessage[][] = [];
  const novaClient = {
    chat: {
      completions: {
        stream: (request: { messages: ChatMessage[] }) => {
          requests.push([...request.messages]);
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
  const executed: Array<Record<string, unknown>> = [];
  let permissionRequests = 0;
  const tool: ToolDefinition = {
    name: "read_file",
    description: "test read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    mutating: true,
    kind: "read",
    execute: async (_context, args) => {
      executed.push(args);
      return { output: "file contents" };
    },
  };
  const messages: ChatMessage[] = [{ role: "user", content: "Read a file." }];

  const result = await runTurn(messages, new AbortController().signal, {
    host: {} as ToolHost,
    sessionId: "test-session",
    cwd: ".",
    environment: {} as ToolEnvironment,
    tools: [tool],
    requestPermission: async () => {
      permissionRequests++;
      return true;
    },
    emit: (event) => {
      events.push(event);
    },
    novaClient,
    model: "test-model",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(executed, [{ path: "src/a.ts" }]);
  // The invalid call is rejected before permission or execution.
  assert.equal(permissionRequests, 1);
  const failed = events.find(
    (event) => event.type === "tool_update" && event.status === "failed",
  );
  assert.ok(failed);
  assert.match(
    String((failed as { output?: string }).output),
    /invalid arguments[\s\S]*missing required "path"/,
  );
  const correction = requests[1]?.at(-1);
  assert.equal(correction?.role, "user");
  assert.match(String(correction?.content), /missing required "path"/);
  assert.match(String(correction?.content), /Expected args:/);
});

test("quoted scalar args are coerced before the tool executes", async () => {
  const rounds = [
    ['```tool_call\n{"name":"search","args":{"query":"x","max":"3","deep":"true"}}\n```'],
    ["Search finished."],
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
  let executedArgs: Record<string, unknown> | null = null;
  const tool: ToolDefinition = {
    name: "search",
    description: "test search",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        max: { type: "integer" },
        deep: { type: "boolean" },
      },
      required: ["query"],
    },
    mutating: false,
    kind: "search",
    execute: async (_context, args) => {
      executedArgs = args;
      return { output: "no matches" };
    },
  };
  const messages: ChatMessage[] = [{ role: "user", content: "Search." }];

  const result = await runTurn(messages, new AbortController().signal, {
    host: {} as ToolHost,
    sessionId: "test-session",
    cwd: ".",
    environment: {} as ToolEnvironment,
    tools: [tool],
    requestPermission: async () => true,
    emit: () => {},
    novaClient,
    model: "test-model",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(executedArgs, { query: "x", max: 3, deep: true });
});

test("repeated invalid tool args still terminate at the tool safety ceiling", async () => {
  const invalidCall = '```tool_call\n{"name":"read_file","args":{}}\n```';
  const rounds = [
    [invalidCall],
    [invalidCall],
    ["I could not produce valid arguments; giving up."],
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
  let executions = 0;
  const tool: ToolDefinition = {
    name: "read_file",
    description: "test read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    mutating: false,
    kind: "read",
    execute: async () => {
      executions++;
      return { output: "file contents" };
    },
  };
  const messages: ChatMessage[] = [{ role: "user", content: "Read a file." }];

  const result = await runTurn(messages, new AbortController().signal, {
    host: {} as ToolHost,
    sessionId: "test-session",
    cwd: ".",
    environment: {} as ToolEnvironment,
    tools: [tool],
    requestPermission: async () => true,
    emit: () => {},
    novaClient,
    model: "test-model",
    maxToolRounds: 2,
  });

  assert.equal(result.stopReason, "max_turn_requests");
  assert.equal(executions, 0);
});

test("proactive compaction fires before the first request when the estimate exceeds the threshold", async () => {
  const rounds = [["All done."]];
  const requests: ChatMessage[][] = [];
  const novaClient = {
    chat: {
      completions: {
        stream: (request: { messages: ChatMessage[] }) => {
          requests.push([...request.messages]);
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

  const bulky = "x".repeat(8_000);
  const messages: ChatMessage[] = [
    { role: "user", content: bulky },
    { role: "assistant", content: bulky },
    { role: "user", content: "Summarize." },
  ];
  let compactCalls = 0;
  let compactError: unknown = "unset";
  const events: AgentEvent[] = [];

  const result = await runTurn(messages, new AbortController().signal, {
    host: {} as ToolHost,
    sessionId: "test-session",
    cwd: ".",
    environment: {} as ToolEnvironment,
    tools: [],
    requestPermission: async () => true,
    compactContext: async (currentMessages, error) => {
      compactCalls++;
      compactError = error;
      currentMessages.splice(0, currentMessages.length, {
        role: "system",
        content: "[Conversation context compacted]",
      }, { role: "user", content: "Summarize." });
      return { compacted: true, history: [], removedMessages: 2, keptMessages: 1 };
    },
    contextWindow: 1_000,
    emit: (event) => {
      events.push(event);
    },
    novaClient,
    model: "test-model",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(compactCalls, 1);
  assert.equal(compactError, null);
  // The first (and only) request already saw the compacted history.
  assert.equal(requests.length, 1);
  assert.match(String(requests[0]?.[0]?.content), /context compacted/);
  assert.ok(events.some((event) => event.type === "context_compacted"));
});

test("proactive compaction is skipped when usage stays under the threshold", async () => {
  const rounds = [["All done."]];
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
  let compactCalls = 0;

  const result = await runTurn(
    [{ role: "user", content: "Small prompt." }],
    new AbortController().signal,
    {
      host: {} as ToolHost,
      sessionId: "test-session",
      cwd: ".",
      environment: {} as ToolEnvironment,
      tools: [],
      requestPermission: async () => true,
      compactContext: async () => {
        compactCalls++;
        return { compacted: false, history: [], removedMessages: 0, keptMessages: 1 };
      },
      contextWindow: 100_000,
      emit: () => {},
      novaClient,
      model: "test-model",
    },
  );

  assert.equal(result.stopReason, "end_turn");
  assert.equal(compactCalls, 0);
});
