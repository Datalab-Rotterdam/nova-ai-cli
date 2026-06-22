import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { writeFileTool } from "../../../src/acp/tools/write-file.js";
import type { ToolContext } from "../../../src/acp/tools/types.js";

function makeContext(request: (method: string, params: unknown) => Promise<unknown>): ToolContext {
  return {
    client: { request } as unknown as acp.AgentContext,
    sessionId: "session-1",
    signal: new AbortController().signal,
  };
}

describe("writeFileTool", () => {
  it("errors without calling the client when path is missing", async () => {
    let called = false;
    const ctx = makeContext(async () => {
      called = true;
      return {};
    });

    const result = await writeFileTool.execute(ctx, { content: "hi" });

    assert.deepEqual(result, { error: "write_file requires a 'path' argument." });
    assert.equal(called, false);
  });

  it("requests fs/write_text_file with path and content", async () => {
    const ctx = makeContext(async (method, params) => {
      assert.equal(method, "fs/write_text_file");
      assert.deepEqual(params, { sessionId: "session-1", path: "/tmp/x", content: "hello" });
      return {};
    });

    const result = await writeFileTool.execute(ctx, { path: "/tmp/x", content: "hello" });

    assert.deepEqual(result, { output: "Wrote 5 characters to /tmp/x." });
  });

  it("returns an error when the client request rejects", async () => {
    const ctx = makeContext(async () => {
      throw new Error("permission denied");
    });

    const result = await writeFileTool.execute(ctx, { path: "/tmp/x", content: "hi" });

    assert.deepEqual(result, { error: "permission denied" });
  });
});
