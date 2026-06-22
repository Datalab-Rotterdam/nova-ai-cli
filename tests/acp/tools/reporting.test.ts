import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { readFileTool } from "../../../src/acp/tools/read-file.js";
import { sendToolCallPending, sendToolCallUpdate } from "../../../src/acp/tools/reporting.js";
import type { ToolContext } from "../../../src/acp/tools/types.js";

function makeContext(notify: (method: string, params: unknown) => Promise<void>): ToolContext {
  return {
    client: { notify } as unknown as acp.AgentContext,
    sessionId: "session-1",
    signal: new AbortController().signal,
  };
}

describe("sendToolCallPending", () => {
  it("notifies a tool_call session update with the right shape", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const ctx = makeContext(async (method, params) => {
      calls.push({ method, params });
    });

    await sendToolCallPending(ctx, "call-1", readFileTool, { path: "/tmp/x" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "session/update");
    const params = calls[0].params as any;
    assert.equal(params.sessionId, "session-1");
    assert.equal(params.update.sessionUpdate, "tool_call");
    assert.equal(params.update.toolCallId, "call-1");
    assert.equal(params.update.status, "pending");
    assert.equal(params.update.kind, "read");
  });
});

describe("sendToolCallUpdate", () => {
  it("notifies a completed tool_call_update with the output", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const ctx = makeContext(async (method, params) => {
      calls.push({ method, params });
    });

    await sendToolCallUpdate(ctx, "call-1", "completed", "file contents");

    const params = calls[0].params as any;
    assert.equal(params.update.sessionUpdate, "tool_call_update");
    assert.equal(params.update.status, "completed");
    assert.equal(params.update.content[0].content.text, "file contents");
  });
});
