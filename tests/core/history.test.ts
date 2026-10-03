import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "@datalabrotterdam/nova-sdk";
import {
  assistantToolCalls,
  assistantVisibleText,
  isToolResultMessage,
  legacyToolOutcomes,
  sanitizeForNative,
  toLegacyMessages,
} from "../../src/core/history.js";

const native = (id: string, name: string, args: object): ChatMessage => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

describe("history helpers", () => {
  it("reads tool calls from native and legacy assistant messages", () => {
    assert.deepEqual(assistantToolCalls(native("c1", "read_file", { path: "a" })), [
      { id: "c1", name: "read_file", args: { path: "a" } },
    ]);
    const legacy: ChatMessage = {
      role: "assistant",
      content:
        'Look.\n```tool_call\n{"name":"read_file","args":{"path":"a"}}\n```\n```tool_call\n{"name":"read_file","args":{"path":"b"}}\n```',
    };
    assert.deepEqual(
      assistantToolCalls(legacy).map((c) => c.args.path),
      ["a", "b"],
    );
    assert.equal(assistantVisibleText(legacy).trim(), "Look.");
  });

  it("recognizes tool results in both formats", () => {
    assert.ok(isToolResultMessage({ role: "tool", tool_call_id: "x", content: "y" }));
    assert.ok(isToolResultMessage({ role: "user", content: "Tool result: y" }));
    assert.ok(!isToolResultMessage({ role: "user", content: "hello" }));
  });

  it("parses legacy batch results per call", () => {
    assert.deepEqual(
      legacyToolOutcomes(
        "Tool results (2 calls):\n[1] read_file → ok\nTool result: A\nline 2\n[2] write_file → rejected\nTool call rejected by user.",
      ),
      [
        { status: "completed", output: "A\nline 2", name: "read_file" },
        { status: "failed", output: "Tool call rejected by user.", name: "write_file" },
      ],
    );
    assert.equal(legacyToolOutcomes("just text"), null);
  });

  it("answers unanswered calls and demotes orphan tool messages", () => {
    const input: ChatMessage[] = [
      { role: "tool", tool_call_id: "lost", content: "Tool result: old" },
      native("c1", "read_file", { path: "a" }),
      { role: "user", content: "next" },
    ];
    const output = sanitizeForNative(input);
    assert.deepEqual(output.map((m) => m.role), ["user", "assistant", "tool", "user"]);
    assert.equal(output[2]!.tool_call_id, "c1");
    assert.equal(input.length, 3, "input is not mutated");
  });

  it("converts native exchanges to the legacy text protocol", () => {
    const output = toLegacyMessages([
      {
        role: "assistant",
        content: "Both.",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
          { id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"b"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "Tool result: A" },
      { role: "tool", tool_call_id: "c2", content: "Tool error: missing" },
    ]);
    assert.equal(output.length, 2);
    assert.ok(!("tool_calls" in output[0]!));
    assert.equal(assistantToolCalls(output[0]!).length, 2);
    assert.deepEqual(legacyToolOutcomes(String(output[1]!.content)), [
      { status: "completed", output: "A", name: "read_file" },
      { status: "failed", output: "missing", name: "read_file" },
    ]);
  });
});

describe("restoring the TUI transcript", () => {
  it("restores every call of native and legacy batches with its own result", async () => {
    const { restoreSessionMessages } = await import("../../src/tui/session/session-runner.js");
    const restored = restoreSessionMessages([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "Native.",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
          { id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"b"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c2", content: "Tool error: missing" },
      { role: "tool", tool_call_id: "c1", content: "Tool result: A" },
      {
        role: "assistant",
        content:
          '```tool_call\n{"name":"read_file","args":{"path":"c"}}\n```\n```tool_call\n{"name":"read_file","args":{"path":"d"}}\n```',
      },
      {
        role: "user",
        content: "Tool results (2 calls):\n[1] read_file → ok\nTool result: C\n[2] read_file → error\nTool error: nope",
      },
      { role: "assistant", content: "All done." },
    ]);
    const tools = restored.flatMap((m) => (m.role === "tool" ? [m.call] : []));
    assert.deepEqual(
      tools.map((call) => [call.args.path, call.status, call.output]),
      [
        ["a", "completed", "A"],
        ["b", "failed", "missing"],
        ["c", "completed", "C"],
        ["d", "failed", "nope"],
      ],
    );
    assert.deepEqual(
      restored.filter((m) => m.role !== "tool").map((m) => m.role),
      ["user", "assistant", "assistant"],
    );
  });
});
