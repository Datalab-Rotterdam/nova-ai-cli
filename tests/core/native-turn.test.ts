import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage, NovaAI } from "@datalabrotterdam/nova-sdk";
import type { AgentEvent } from "../../src/core/agent-events.js";
import { ToolCallingUnsupportedError } from "../../src/core/model/tool-support.js";
import { runTurn, type RunTurnDeps } from "../../src/core/run-turn.js";
import type { ToolHost } from "../../src/core/tool-host.js";
import type { ToolEnvironment } from "../../src/core/tools/environment.js";
import type { ToolDefinition } from "../../src/core/tools/types.js";

type Chunk = Record<string, unknown>;

/** Fake client: each request pops the next list of chunks (or an error). */
function fakeClient(rounds: Array<Chunk[] | Error>) {
  const requests: Array<Record<string, unknown>> = [];
  const novaClient = {
    chat: {
      completions: {
        stream: (request: Record<string, unknown>) => {
          requests.push(structuredClone(request));
          const next = rounds.shift() ?? [];
          return (async function* () {
            if (next instanceof Error) throw next;
            for (const choice of next) {
              yield { type: "chunk", data: { choices: [choice] } };
            }
            yield { type: "done" };
          })();
        },
      },
    },
  } as unknown as NovaAI;
  return { novaClient, requests };
}

const text = (content: string, finish_reason?: string): Chunk => ({
  delta: { content },
  ...(finish_reason ? { finish_reason } : {}),
});
const call = (index: number, id: string, name: string, args: unknown): Chunk => ({
  delta: {
    tool_calls: [
      { index, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  },
});
const finish = (reason: string): Chunk => ({ delta: {}, finish_reason: reason });

function tool(
  name: string,
  execute: ToolDefinition["execute"],
  mutating = false,
): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    mutating,
    kind: mutating ? "edit" : "read",
    execute,
  };
}

function deps(
  novaClient: NovaAI,
  tools: ToolDefinition[],
  overrides: Partial<RunTurnDeps> = {},
): RunTurnDeps & { events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    host: {} as ToolHost,
    sessionId: "s",
    cwd: ".",
    environment: {} as ToolEnvironment,
    tools,
    requestPermission: async () => true,
    emit: (event) => void events.push(event),
    novaClient,
    model: "m",
    toolProtocol: "native",
    events,
    ...overrides,
  };
}

describe("native tool calling", () => {
  it("sends tools, runs the call and answers it with a tool message", async () => {
    const { novaClient, requests } = fakeClient([
      [text("Reading. "), call(0, "call_1", "read_file", { path: "a.ts" }), finish("tool_calls")],
      [text("Done.", "stop")],
    ]);
    const reads: unknown[] = [];
    const d = deps(novaClient, [
      tool("read_file", async (_ctx, args) => (reads.push(args), { output: "content" })),
    ]);
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];

    const result = await runTurn(messages, new AbortController().signal, d);

    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(reads, [{ path: "a.ts" }]);
    const first = requests[0]!;
    assert.equal(first.tool_choice, "auto");
    assert.deepEqual(
      (first.tools as Array<{ function: { name: string } }>).map((t) => t.function.name),
      ["read_file"],
    );
    assert.deepEqual(result.turnMessages, [
      {
        role: "assistant",
        content: "Reading. ",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "Tool result: content" },
      { role: "assistant", content: "Done." },
    ]);
    // The second request carries the exchange in native form.
    const second = requests[1]!.messages as ChatMessage[];
    assert.equal(second.at(-1)?.role, "tool");
    assert.ok(!JSON.stringify(requests).includes("```tool_call"));
  });

  it("answers several calls from one response in order", async () => {
    const { novaClient } = fakeClient([
      [
        call(0, "c1", "read_file", { path: "a" }),
        call(1, "c2", "read_file", { path: "b" }),
        finish("tool_calls"),
      ],
      [text("ok", "stop")],
    ]);
    const d = deps(novaClient, [
      tool("read_file", async (_ctx, args) => ({ output: String(args.path) })),
    ]);
    const result = await runTurn([{ role: "user", content: "go" }], new AbortController().signal, d);
    const tools = result.turnMessages.filter((m) => m.role === "tool");
    assert.deepEqual(
      tools.map((m) => [m.tool_call_id, m.content]),
      [
        ["c1", "Tool result: a"],
        ["c2", "Tool result: b"],
      ],
    );
  });

  it("reports reasoning as thoughts, not as answer text", async () => {
    const { novaClient } = fakeClient([
      [
        { delta: { reasoning_content: "thinking hard" } },
        text("<think>more</think>Answer.", "stop"),
      ],
    ]);
    const d = deps(novaClient, []);
    const result = await runTurn([{ role: "user", content: "q" }], new AbortController().signal, d);
    assert.deepEqual(
      d.events.filter((e) => e.type === "thought").map((e) => (e as { text: string }).text).join(""),
      "thinking hardmore",
    );
    assert.deepEqual(
      d.events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join(""),
      "Answer.",
    );
    assert.deepEqual(result.turnMessages, [{ role: "assistant", content: "Answer." }]);
  });

  it("never executes tool calls from a response cut off by the token limit", async () => {
    const { novaClient } = fakeClient([
      [call(0, "c1", "write_file", { path: "big.ts" }), finish("length")],
      [text("I will split it.", "stop")],
    ]);
    let writes = 0;
    const d = deps(novaClient, [
      tool("write_file", async () => (writes++, { output: "written" }), true),
    ]);
    const result = await runTurn([{ role: "user", content: "go" }], new AbortController().signal, d);
    assert.equal(writes, 0);
    assert.ok(
      result.turnMessages.some(
        (m) => m.role === "user" && String(m.content).includes("cut off while writing tool call arguments"),
      ),
    );
    assert.ok(!result.turnMessages.some((m) => "tool_calls" in m));
  });

  it("signals unsupported native tools before touching history", async () => {
    const rejection = Object.assign(new Error("tools are not supported by this model"), {
      status: 400,
    });
    const { novaClient } = fakeClient([rejection]);
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await assert.rejects(
      runTurn(messages, new AbortController().signal, deps(novaClient, [tool("read_file", async () => ({ output: "" }))])),
      ToolCallingUnsupportedError,
    );
    assert.deepEqual(messages, [{ role: "user", content: "go" }]);
  });

  it("keeps finished results and answers the rest when cancelled mid-batch", async () => {
    const { novaClient } = fakeClient([
      [
        call(0, "c1", "read_file", { path: "a" }),
        call(1, "c2", "slow", { path: "b" }),
        finish("tool_calls"),
      ],
    ]);
    const controller = new AbortController();
    const d = deps(novaClient, [
      tool("read_file", async () => ({ output: "A" })),
      tool("slow", async ({ signal }) => {
        controller.abort();
        signal.throwIfAborted();
        return { output: "never" };
      }),
    ]);
    const result = await runTurn([{ role: "user", content: "go" }], controller.signal, d);
    assert.equal(result.stopReason, "cancelled");
    assert.deepEqual(
      result.turnMessages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.content]),
      [
        ["c1", "Tool result: A"],
        ["c2", "Tool error: Cancelled before this call completed."],
      ],
    );
  });

  it("answers every call id when the user rejects one", async () => {
    const { novaClient } = fakeClient([
      [
        call(0, "c1", "write_file", { path: "a" }),
        call(1, "c2", "write_file", { path: "b" }),
        finish("tool_calls"),
      ],
      [text("Understood.", "stop")],
    ]);
    const d = deps(novaClient, [tool("write_file", async () => ({ output: "x" }), true)], {
      requestPermission: async () => false,
    });
    const result = await runTurn([{ role: "user", content: "go" }], new AbortController().signal, d);
    assert.deepEqual(
      result.turnMessages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
      ["c1", "c2"],
    );
    assert.match(String(result.turnMessages[2]!.content), /^Skipped:/);
  });

  it("turns calls to unknown tools into an error result", async () => {
    const { novaClient } = fakeClient([
      [call(0, "c1", "made_up", { path: "a" }), finish("tool_calls")],
      [text("ok", "stop")],
    ]);
    const result = await runTurn(
      [{ role: "user", content: "go" }],
      new AbortController().signal,
      deps(novaClient, [tool("read_file", async () => ({ output: "" }))]),
    );
    assert.equal(result.turnMessages[1]!.content, 'Tool "made_up" is not available.');
  });
});

describe("text protocol with native history", () => {
  it("renders earlier native exchanges as text for the model", async () => {
    const { novaClient, requests } = fakeClient([[text("fine", "stop")]]);
    const history: ChatMessage[] = [
      { role: "user", content: "earlier" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "Tool result: A" },
      { role: "user", content: "now" },
    ];
    await runTurn(history, new AbortController().signal, {
      ...deps(novaClient, []),
      toolProtocol: "text",
    });
    const sent = requests[0]!.messages as ChatMessage[];
    assert.ok(sent.every((m) => m.role !== "tool" && !("tool_calls" in m)));
    assert.match(String(sent[1]!.content), /```tool_call\n\{"name":"read_file","args":\{"path":"a"\}\}\n```/);
    assert.equal(sent[2]!.content, "Tool result: A");
  });
});

describe("native mode with text-written calls", () => {
  it("executes a ```tool_call fence the model wrote instead of a native call", async () => {
    const { novaClient } = fakeClient([
      [
        text("Checking.\n```tool_"),
        text('call\n{"name": "read_file", "args": {"path": "a.ts"}}\n```'),
        finish("stop"),
      ],
      [text("Done.", "stop")],
    ]);
    const reads: unknown[] = [];
    const d = deps(novaClient, [
      tool("read_file", async (_ctx, args) => (reads.push(args), { output: "A" })),
    ]);
    const result = await runTurn([{ role: "user", content: "go" }], new AbortController().signal, d);
    assert.deepEqual(reads, [{ path: "a.ts" }]);
    const shown = d.events
      .filter((e) => e.type === "text")
      .map((e) => (e as { text: string }).text)
      .join("");
    assert.ok(!shown.includes("tool_call"), shown);
    assert.equal(result.turnMessages[1]!.role, "tool");
  });

  it("shows a fence for an unknown tool as plain text", async () => {
    const { novaClient } = fakeClient([
      [text('```tool_call\n{"name": "nope", "args": {}}\n```'), finish("stop")],
    ]);
    const d = deps(novaClient, [tool("read_file", async () => ({ output: "" }))]);
    const result = await runTurn([{ role: "user", content: "go" }], new AbortController().signal, d);
    assert.match(String(result.turnMessages.at(-1)!.content), /tool_call/);
  });
});
