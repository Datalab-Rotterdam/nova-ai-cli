import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { requestPermissionIfNeeded } from "../../../src/acp/tools/permission.js";
import { readFileTool } from "../../../src/acp/tools/read-file.js";
import { writeFileTool } from "../../../src/acp/tools/write-file.js";
import type { ToolContext } from "../../../src/acp/tools/types.js";

function makeContext(request: (method: string, params: unknown) => Promise<unknown>): ToolContext {
  return {
    client: { request } as unknown as acp.AgentContext,
    sessionId: "session-1",
    signal: new AbortController().signal,
  };
}

describe("requestPermissionIfNeeded", () => {
  it("skips the permission request for non-mutating tools", async () => {
    let called = false;
    const ctx = makeContext(async () => {
      called = true;
      throw new Error("should not be called");
    });

    const allowed = await requestPermissionIfNeeded(ctx, "call-1", readFileTool, { path: "/tmp/x" });

    assert.equal(allowed, true);
    assert.equal(called, false);
  });

  it("allows a mutating tool when the user selects the allow option", async () => {
    const ctx = makeContext(async () => ({ outcome: { outcome: "selected", optionId: "allow" } }));

    const allowed = await requestPermissionIfNeeded(ctx, "call-1", writeFileTool, { path: "/tmp/x", content: "hi" });

    assert.equal(allowed, true);
  });

  it("rejects a mutating tool when the user selects the reject option", async () => {
    const ctx = makeContext(async () => ({ outcome: { outcome: "selected", optionId: "reject" } }));

    const allowed = await requestPermissionIfNeeded(ctx, "call-1", writeFileTool, { path: "/tmp/x", content: "hi" });

    assert.equal(allowed, false);
  });

  it("rejects a mutating tool when the permission request is cancelled", async () => {
    const ctx = makeContext(async () => ({ outcome: { outcome: "cancelled" } }));

    const allowed = await requestPermissionIfNeeded(ctx, "call-1", writeFileTool, { path: "/tmp/x", content: "hi" });

    assert.equal(allowed, false);
  });
});
