import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { restoreSessionMessages } from "../../src/tui/session/session-runner.js";

describe("restoring the TUI transcript", () => {
  it("restores every call of native and legacy batches with its own result", async () => {
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
